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
      await Logger.error("File not found");
      return 1;
    }

    let totalElement = 266688348;
    let perChunk = 10000 * 8;

    let totalBatches = Math.ceil(totalElement / perChunk);

    await Logger.info(`Total batches: ${totalBatches}`);

    ProgressBar.addBar(totalBatches, "Analyzing CSV, batches", "cyan");

    let resolveCsvCommand: (value: (PromiseLike<unknown> | unknown)) => void;

    const endPromise = new Promise((res) => {
      resolveCsvCommand = res;
    });

    let currentRows: { [p: number]: Row[] } = {
      0: [],
      1: [],
      2: [],
      3: [],
      4: [],
      5: [],
      6: [],
      7: [],
      8: [],
      9: [],
      10: [],
      11: [],
      12: [],
      13: [],
      14: [],
      15: [],
    };

    const stream = fs.createReadStream(filePath)

    const csvStream = parseStream(
      stream,
      {
        delimiter: ";",
        headers: ["1", "2", "3", "4", "5", "6", "7", "8"]
      }
    );

    let currentIndex = 0;

    csvStream
      .on("data", (row: Row) => {
        if (currentIndex === 15) {
          currentIndex = 0;
        }

        let jobIndex = currentIndex;

        currentIndex++;

        if (currentRows[15].length !== perChunk) {
          currentRows[jobIndex].push(row);
          return;
        }

        Logger.info("Executing batch, pausing stream");

        csvStream.pause();

        const promisesToWaitFor: (() => Promise<void>)[] = [];

        for (const rowsArray of Object.values(currentRows)) {
          promisesToWaitFor.push(
            () => new Promise((resP) => {
                Jobs
                  .runWithoutDispatch<AnalyzeDomainsCsvJobParameters>(
                    "AnalyzeDomainsCsv",
                    {
                      rows: rowsArray
                    }
                  )
                  .finally(() => {
                    resP();
                  })
              }
            )
          );
        }

        Promise
          .all(promisesToWaitFor.map((fn) => fn()))
          .finally(async () => {
            currentRows = {
              0: [],
              1: [],
              2: [],
              3: [],
              4: [],
              5: [],
              6: [],
              7: [],
              8: [],
              9: [],
              10: [],
              11: [],
              12: [],
              13: [],
              14: [],
              15: [],
            }

            await Logger.info("Batch finished analysing, resuming stream");

            ProgressBar.next();

            csvStream.resume();
          });
      })
      .on("end", async () => {

        if (
          Object
            .values(currentRows)
            .filter((rows) => rows.length > 0)
            .length === 0
        ) {
          const promisesToWaitFor: (() => Promise<void>)[] = [];

          let i = 0;
          for (let entry of Object.entries(currentRows).filter((rows) => rows[1].length > 0)) {
            promisesToWaitFor.push(
              () => new Promise((resP) => {
                  Jobs
                    .runWithoutDispatch<AnalyzeDomainsCsvJobParameters>(
                      "AnalyzeDomainsCsv",
                      {
                        rows: entry[1]
                      },
                      [],
                      undefined,
                      undefined,
                      i.toString()
                    )
                    .finally(() => {
                      resP();
                    })
                }
              )
            );
            i++;
          }

          await Logger.info("Executing last batch");

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
