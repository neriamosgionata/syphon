import {BaseCommand} from '@adonisjs/core/build/standalone'
import fs from "fs";
import ProgressBar from "@ioc:Providers/ProgressBar";
import Logger from '@ioc:Providers/Logger';
import {AnalyzeDomainsCsvJobParameters, Row} from "App/Jobs/AnalyzeDomainsCsv";
import Jobs from "@ioc:Providers/Jobs";
import {parseStream} from "fast-csv";
import path from "path";
import Config from "@ioc:Adonis/Core/Config";

export default class AnalyzeDomainsCsv extends BaseCommand {
  /**
   * Command name is used to run the command
   */
  public static commandName = 'analyze:domains_csv'

  /**
   * Command description is displayed in the "help" output
   */
  public static description = ''

  public static settings = {
    /**
     * Set the following value to true, if you want to load the application
     * before running the command. Don't forget to call `node ace generate:manifest`
     * afterwards.
     */
    loadApp: true,

    /**
     * Set the following value to true, if you want this command to keep running until
     * you manually decide to exit the process. Don't forget to call
     * `node ace generate:manifest` afterwards.
     */
    stayAlive: false,
  }

  public async run() {
    const filePath = path.join(Config.get("app.storage.data_folder"), "domains-detailed.csv");
    const filePathEnd = path.join(Config.get("app.storage.data_folder"), "domains-detailed-found.csv");

    if (fs.existsSync(filePathEnd)) {
      fs.unlinkSync(filePathEnd);
    }

    if (!fs.existsSync(filePath)) {
      Logger.error("File not found");
      return 1;
    }

    let totalElement = 266688348;
    let singleRows = 50000;
    let perChunk = singleRows * 16;

    let totalBatches = Math.ceil(totalElement / perChunk);

    Logger.info(`Total batches: ${totalBatches}`);

    ProgressBar.addBar(totalBatches, "Analyzing CSV, batches", "cyan");

    let resolveCsvCommand: (value: (PromiseLike<unknown> | unknown)) => void;

    const endPromise = new Promise((res) => {
      resolveCsvCommand = res;
    });

    let currentRows: Row[][] = [
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
    ]

    const stream = fs.createReadStream(filePath)

    const csvStream = parseStream(
      stream,
      {
        delimiter: ";",
        headers: ["1", "2", "3", "4", "5", "6", "7", "8"]
      }
    );

    let currentIndex = 0;
    let added = 0;

    csvStream
      .on("data", (row: Row) => {
        if (currentIndex === 16) {
          currentIndex = 0;
        }

        let jobIndex = currentIndex;

        currentIndex++;

        if (added < perChunk) {
          currentRows[jobIndex].push(row);
          added++;
          return;
        }

        Logger.info("Executing batch, pausing stream, added " + added + " rows");

        added = 0;

        csvStream.pause();

        const promisesToWaitFor = currentRows
          .map((rows, i) => {
            return () => new Promise<void>((resP) => {
                Jobs
                  .runWithoutDispatch<AnalyzeDomainsCsvJobParameters>(
                    "AnalyzeDomainsCsv",
                    {
                      rows: [...rows]
                    },
                    ["domains-detailed-found.csv"],
                    undefined,
                    undefined,
                    i.toString(),
                  )
                  .finally(() => {
                    resP();
                  })
              }
            );
          });

        currentRows = [
          [],
          [],
          [],
          [],
          [],
          [],
          [],
          [],
          [],
          [],
          [],
          [],
          [],
          [],
          [],
          [],
        ];

        Promise
          .all(promisesToWaitFor.map((fn) => fn()))
          .finally(async () => {
            Logger.info("Batch finished analysing, resuming stream");

            ProgressBar.next();

            csvStream.resume();
          });
      })
      .on("end", async () => {

        if (
          currentRows
            .filter((rows) => rows.length > 0)
            .length === 0
        ) {
          const promisesToWaitFor = currentRows
            .filter((rows) => rows.length > 0)
            .map((rows, i) => {
              return () => new Promise<void>((resP) => {
                  Jobs
                    .runWithoutDispatch<AnalyzeDomainsCsvJobParameters>(
                      "AnalyzeDomainsCsv",
                      {
                        rows: [...rows]
                      },
                      ["domains-detailed-found.csv"],
                      undefined,
                      undefined,
                      i.toString(),
                    )
                    .finally(() => {
                      resP();
                    })
                }
              );
            });

          Logger.info("Executing last batch");

          await Promise.all(promisesToWaitFor.map((fn) => fn()));

          ProgressBar.next();
        }

        ProgressBar.stop();

        resolveCsvCommand(null);

      });

    await endPromise;

    return 0;
  }
}
