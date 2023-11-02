import {BaseCommand} from '@adonisjs/core/build/standalone'
import fs from "fs";
import ProgressBar from "@ioc:Providers/ProgressBar";
import Logger from '@ioc:Providers/Logger';
import Jobs from "@ioc:Providers/Jobs";
import {parseStream} from "fast-csv";
import path from "path";
import Config from "@ioc:Adonis/Core/Config";
import {MatchDomainsCsvJobParameters, Row} from "App/Jobs/MatchDomainsCsvJob";

export default class MatchDomainsCsv extends BaseCommand {
  /**
   * Command name is used to run the command
   */
  public static commandName = 'match:domains_csv'

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

  private mapFunction(rows: Row[], toMatch: { "1": string, "2": string }[], index: number): () => Promise<void> {
    return () => new Promise<void>((resP) => {
        Jobs
          .runWithoutDispatch<MatchDomainsCsvJobParameters>(
            "MatchDomainsCsvJob",
            {
              rows: [...rows],
              toMatch: [...toMatch],
            },
            ["domains-detailed-matched.csv"],
            undefined,
            undefined,
            index.toString(),
          )
          .finally(() => {
            resP();
          })
      }
    );
  }

  public async run() {
    const filePath = path.join(Config.get("app.storage.data_folder"), "domains-detailed.csv");
    const filePathEnd = path.join(Config.get("app.storage.data_folder"), "domains-detailed-matched.csv");
    const filePathMatch = path.join(Config.get("app.storage.data_folder"), "bp-campari.csv");

    if (fs.existsSync(filePathEnd)) {
      fs.unlinkSync(filePathEnd);
    }

    if (!fs.existsSync(filePath)) {
      Logger.error("File not found");
      return 1;
    }

    //STEP 1
    const toMatch: { "1": string, "2": string }[] = [];

    let resolveCsvMatchCommand: (value: (PromiseLike<unknown> | unknown)) => void;
    const promiseMatch = new Promise((res) => {
      resolveCsvMatchCommand = res;
    });
    const csvStreamMatch = parseStream(
      fs.createReadStream(filePathMatch),
      {
        delimiter: ",",
        headers: ["1", "2"],
        ignoreEmpty: true,
      }
    );

    Logger.info("Loading to match");

    csvStreamMatch
      .on("data", (row: Row) => {
        toMatch.push({
          "1": row["1"],
          "2": row["2"],
        });
      })
      .on("error", (err) => {
        Logger.error("step1: error while streaming: ", err.message, err.stack);
        resolveCsvMatchCommand(null);
      })
      .on("end", async () => {
        Logger.info(`Total to match: ${toMatch.length}`)
        resolveCsvMatchCommand(null);
      });

    await promiseMatch;

    //STEP 2
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
    ];

    let currentIndex = 0;
    let added = 0;

    let totalElement = 266728176;
    let singleRows = 50000;
    let perChunk = singleRows * 8;

    let totalBatches = Math.ceil(totalElement / perChunk);

    Logger.info(`Total csv batches: ${totalBatches}`);

    ProgressBar.addBar(totalBatches, "Analyzing CSV, batches", "cyan");

    let resolveCsvCommand: (value: (PromiseLike<unknown> | unknown)) => void;
    const endPromise = new Promise((res) => {
      resolveCsvCommand = res;
    });

    const csvStream = parseStream(
      fs.createReadStream(filePath),
      {
        delimiter: ";",
        headers: ["1", "2", "3", "4", "5", "6", "7", "8"],
        ignoreEmpty: true,
      }
    );

    csvStream
      .on("data", (row: Row) => {
        if (currentIndex === 15) {
          currentIndex = 0;
        }

        let jobIndex = currentIndex;
        currentIndex++;

        if (added < perChunk) {
          currentRows[jobIndex].push(row);
          added++;
          return;
        }

        added = 0;

        csvStream.pause();

        Promise
          .all(
            currentRows.map((rows, i) => this.mapFunction(rows, toMatch, i)())
          )
          .finally(async () => {
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
            ];
            ProgressBar.next();
            csvStream.resume();
          });
      })
      .on("error", (err) => {
        Logger.error("step2: error while streaming: ", err.message, err.stack);
        ProgressBar.stopAll();
        resolveCsvCommand(null);
      })
      .on("end", async () => {
        const cr = currentRows.filter((rows) => rows.length > 0);

        if (cr.length === 0) {
          await Promise.all(
            cr.map((rows, i) => this.mapFunction(rows, toMatch, i)())
          );
        }

        ProgressBar.stopAll();
        resolveCsvCommand(null);
      });

    await endPromise;

    return 0;
  }
}
