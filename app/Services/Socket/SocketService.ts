import {Server, Socket} from "socket.io";
import Env from "@ioc:Adonis/Core/Env";
import {createServer as createServerHttp} from "http";
import Application from "@ioc:Adonis/Core/Application";
import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {isMainThread} from "node:worker_threads";
import {EmitEventType, EmitEventTypeData, ListenEventType, ListenEventTypeData} from "App/Services/Socket/SocketTypes";
import Job from "App/Models/Job";
import {JobListForFrontend} from "App/Jobs";
import {HttpContext} from "@adonisjs/http-server/build/src/HttpContext";

export interface SocketContract {
  startServer(): void;

  stopServer(): void;

  isBooted(): boolean;

  isEnabled(): boolean;

  emitToAdmins<K extends EmitEventType>(event: K, data: EmitEventTypeData[K]): void;

  addStartupEmitEvent<K extends EmitEventType>(event: K, listener: () => any): void;
}

export default class SocketService implements SocketContract {
  private socketServer!: Server;
  private server: any;
  private registeredAdminSockets!: Map<string, Socket>;
  private registeredStartupEvents: Map<EmitEventType, () => EmitEventTypeData[EmitEventType] | Promise<EmitEventTypeData[EmitEventType]>> = new Map();
  private booted = false;

  private logger: any;

  constructor() {
    this.logger = Application.container.use(AppContainerAliasesEnum.Logger).logger("socket", true);
  }

  createHttpServer() {
    return createServerHttp();
  }

  startServer() {
    if (!this.isEnabled()) {
      return;
    }

    if (this.isBooted()) {
      return;
    }

    if (isMainThread && Application.environment === "web") {
      this.registeredAdminSockets = new Map();

      const server = this.createHttpServer();

      this.socketServer = new Server(
        server,
        {
          path: "/socket/",
          cors: {
            origin: '*',
          },
          serveClient: false,
          allowUpgrades: true,
        },
      );

      this.socketServer.on("connect_error", (err) => {
        this.logger.error("Socket server error: " + err.message);
      });

      const socketPort = Env.get("SOCKET_PORT", 3312);
      server.listen(socketPort);

      Application.container.use(AppContainerAliasesEnum.Console).info("Socket server started on port: " + socketPort);

      this.booted = true;

      this.boot();

      this.server = server;

      this.registerEventsForAdmins();
    }
  }

  async stopServer() {
    if (!this.isEnabled()) {
      return;
    }

    if (this.isBooted() && isMainThread && Application.environment === "web") {
      this.registeredAdminSockets = new Map();
      this.registeredStartupEvents = new Map();

      try {
        this.socketServer.close();
        await this.server.close();
      } catch (e) {

      }
      this.booted = false;
    }
  }

  isBooted() {
    return this.booted;
  }

  isEnabled() {
    return Env.get("SOCKET_ENABLE", false);
  }

  addStartupEmitEvent<K extends EmitEventType>(event: K, listener: (() => EmitEventTypeData[K] | Promise<EmitEventTypeData[K]>)): void {
    this.logger.info("Adding startup emit event: " + event);
    this.registeredStartupEvents.set(event, () => listener());
  }

  private registerEventsForAdmins() {
    if (!this.isEnabled()) {
      return;
    }

    if (!this.isBooted()) {
      return;
    }

    if (isMainThread) {
      if (Application.environment !== "web") {
        return;
      }

      this.socketServer.on("connection", (socket) => {
        this.logger.info("Admin connected id: " + socket.id);

        socket.request.headers.authorization = socket.handshake.auth?.authorization;
        socket.request.headers.Authorization = socket.handshake.auth?.authorization;

        try {
          const ctx = HttpContext.create(
            "/api/v1/charts",
            {} as Record<string, any>,
            socket.request,
          );

          Application
            .container
            .use("Adonis/Addons/Auth")
            // @ts-ignore
            .getAuthForRequest(ctx)
            .authenticate()
            .then(() => {
              this.runStartupEmitEvents(socket)
                .then(() => {
                })
                .catch(() => {
                });

              for (const event of this.getSocketEvents()) {
                this.registerListener(socket, event.event, event.listener);
              }

              this.registeredAdminSockets.set(socket.id, socket);

              this.logger.info("Admin connected id: " + socket.id);

              socket.on("disconnect", () => {
                this.logger.info("Admin disconnected id: " + socket.id);

                this.registeredAdminSockets.delete(socket.id);
              });
            })
            .catch(() => {
              socket.disconnect();
              this.logger.error("Admin not authenticated");
            });
        } catch (e) {
          socket.disconnect();
          this.logger.error("Admin not authenticated");
          return;
        }
      });
    }
  }

  async runStartupEmitEvents(socket: Socket) {
    for (const [event, listener] of this.registeredStartupEvents) {
      try {
        const res = await listener();
        socket.emit(event, res);
      } catch (e) {
        this.logger.error(e.message, e.stack);
      }
    }
  }

  emitToAdmins<K extends EmitEventType>(event: K, data: EmitEventTypeData[K]): void {
    if (!this.isEnabled()) {
      return;
    }

    if (isMainThread) {
      if (!this.isBooted() || Application.environment !== "web") {
        return;
      }

      this.registeredAdminSockets.forEach((socket) => {
        socket.emit(event, data);
      });

      return;
    }

    Application.container.use(AppContainerAliasesEnum.Jobs).socketEmitter(event, data);
  }

  boot() {
    this.addStartupEmitEvent(
      EmitEventType.ALL_JOBS,
      () => {
        this.logger.info("Getting all jobs");
        return Job
          .query()
          .orderBy("created_at", "desc")
          .exec();
      },
    );

    this.addStartupEmitEvent(
      EmitEventType.ALL_AVAILABLE_JOBS,
      () => {
        this.logger.info("Getting all available jobs");
        return JobListForFrontend;
      },
    );

    this.addStartupEmitEvent(
      EmitEventType.GET_ALL_PROGRESS_BARS,
      () => {
        this.logger.info("Getting all progress bars");
        return Application.container.use(AppContainerAliasesEnum.ProgressBar).getAllBarsConfigAndStatus();
      },
    );

    this.addStartupEmitEvent(
      EmitEventType.ALL_AVAILABLE_LOGS,
      () => {
        this.logger.info("Getting all available logs");
        return Application.container.use(AppContainerAliasesEnum.Logger).getAllAvailableLogs();
      },
    );
  }

  getSocketEvents(): { event: ListenEventType, listener: (data: any) => void }[] {
    return [
      {
        event: ListenEventType.START_JOB,
        listener: (data: ListenEventTypeData[ListenEventType.START_JOB]) => {
          this.logger.info("Starting job: " + data.jobName);

          Application.container.use(AppContainerAliasesEnum.Jobs)
            .dispatch(data.jobName, data.parameters, data.tags)
            .then((job) => {

              Application
                .container
                .use(AppContainerAliasesEnum.Jobs)
                .waitUntilDone(job)
                .then(() => {
                  this.logger.info("Job done: " + job.id);
                })
                .catch(() => {
                  this.logger.error("Job failed: " + job.id);
                });

              Job
                .query()
                .where("id", job.id)
                .firstOrFail()
                .then((job) => {
                  this.emitToAdmins(EmitEventType.STARTED_JOB, job);
                })
                .catch(() => {
                  this.logger.error("Job not found: " + job.id);
                });

              this.logger.info("Job started: " + job.id);
            })
            .catch((e) => {
              this.logger.error(e.message, e.stack);
            })
        }
      },

      {
        event: ListenEventType.STOP_JOB,
        listener: (data: ListenEventTypeData[ListenEventType.STOP_JOB]) => {
          this.logger.info("Stopping job: " + data.id);

          Application.container.use(AppContainerAliasesEnum.Jobs)
            .stopJob(data.id)
            .then((job) => {
              this.logger.info("Job stopped: " + job.id);

              this.emitToAdmins(EmitEventType.JOB_STATUS, job);
            })
            .catch((e) => {
              this.logger.error(e.message, e.stack);
            })
        }
      },

      {
        event: ListenEventType.RESTART_JOB,
        listener: (data: ListenEventTypeData[ListenEventType.RESTART_JOB]) => {
          this.logger.info("Restarting job: " + data.id);

          Application.container.use(AppContainerAliasesEnum.Jobs)
            .restartJob(data.id)
            .then((job) => {
              this.logger.info("Job restarted: " + job.id);

              this.emitToAdmins(EmitEventType.JOB_STATUS, job);
            })
            .catch((e) => {
              this.logger.error(e.message, e.stack);
            })
        }
      },

      {
        event: ListenEventType.DELETE_JOB,
        listener: (data: ListenEventTypeData[ListenEventType.DELETE_JOB]) => {
          this.logger.info("Deleting job: " + data.id);

          Application.container.use(AppContainerAliasesEnum.Jobs)
            .deleteJob(data.id)
            .then((job) => {
              this.logger.info("Job deleted: " + job.id);

              this.emitToAdmins(EmitEventType.JOB_DELETED, job);
            })
            .catch((e) => {
              this.logger.error(e.message, e.stack);
            })
        }
      },

      {
        event: ListenEventType.GET_JOB_STATUS,
        listener: (data: ListenEventTypeData[ListenEventType.GET_JOB_STATUS]) => {
          this.logger.info("Getting job status: " + data.id);

          Application.container.use(AppContainerAliasesEnum.Jobs)
            .getSingleJob(data.id)
            .then((job) => {
              this.logger.info("Got job status: " + job.id);

              this.emitToAdmins(EmitEventType.JOB_STATUS, job);
            })
            .catch((e) => {
              this.logger.error(e.message, e.stack);
            });
        }
      },

      {
        event: ListenEventType.GET_ALL_JOBS,
        listener: () => {

          Application.container.use(AppContainerAliasesEnum.Jobs)
            .getAllJobs()
            .then((jobs) => {
              this.emitToAdmins(EmitEventType.ALL_JOBS, jobs);
            })
            .catch((e) => {
              this.logger.error(e.message, e.stack);
            });
        }
      },

      {
        event: ListenEventType.SELECT_LOG,
        listener: (data: ListenEventTypeData[ListenEventType.SELECT_LOG]) => {
          this.logger.info("Selecting log: " + data.name);

          Application.container.use(AppContainerAliasesEnum.Logger)
            .tailLog(
              data.name,
              (logLine: string) => {
                this.emitToAdmins(EmitEventType.LOG_LINE, {logLine});
              },
              (logData: { logs: string[], name: string }) => {
                this.emitToAdmins(EmitEventType.ALL_LOGS, logData);
              },
            );
        }
      },

      {
        event: ListenEventType.DELETE_LOG,
        listener: (data: ListenEventTypeData[ListenEventType.DELETE_LOG]) => {
          this.logger.info("Deleting log: " + data.name);

          Application.container.use(AppContainerAliasesEnum.Logger)
            .deleteLog(data.name);
        }
      },

      {
        event: ListenEventType.GET_ALL_LOGS,
        listener: () => {
          const logs = Application.container.use(AppContainerAliasesEnum.Logger).getAllAvailableLogs();
          this.emitToAdmins(EmitEventType.ALL_AVAILABLE_LOGS, logs);
        }
      }
    ];
  }

  private registerListener<K extends ListenEventType>(socket: any, event: K, listener: (data: ListenEventTypeData[K]) => void): void {
    if (!this.isEnabled()) {
      return;
    }

    if (!this.isBooted()) {
      return;
    }

    socket.on(event, listener);
  }

}
