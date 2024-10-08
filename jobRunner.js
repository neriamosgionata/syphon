require("reflect-metadata");
const sourceMapSupport = require("source-map-support");
const {Ignitor} = require("@adonisjs/core/build/standalone");
const {workerData} = require("worker_threads");
const fs = require("fs");

sourceMapSupport.install({handleUncaughtExceptions: false});

const kernel = new Ignitor(__dirname).kernel("unknown");

const run = async () => {
  await kernel.registerTsCompilerHook();
  await kernel.boot();
  await kernel.start();

  const jobPath = workerData.jobPath;

  /** @type import('app/Services/Jobs/JobHelpers').RunJobFunction */
  let job = null;

  if (fs.existsSync(jobPath + ".js")) {
    job = require(jobPath + ".js").default;
  } else if (fs.existsSync(jobPath + ".ts")) {
    job = require(jobPath + ".ts").default;
  } else {
    throw new Error("Job not found");
  }

  return job();
};

let error = null;

run()
  .then(() => {
  })
  .catch((e) => (error = e))
  .finally(() => {
    kernel
      .close()
      .then(() => {
      })
      .catch(() => {
      })
      .finally(() => {
        if (error) {
          throw error;
        }
        process.exit(error ? 1 : 0);
      });
  });
