import {loadData, runJob} from "App/Services/Jobs/JobHelpers";
import fs from "fs";
import fuzz from "fuzzball";
import Config from "@ioc:Adonis/Core/Config";
import path from "path";
import Logger from "@ioc:Providers/Logger";

const EXCLUDE = {
  "Campari": [],
  "Aperol": [],
  "Skyyvodka": [],
  "Wild Turkey": [],
  "Grand Marnier": [],
  "Espolon": [],
  "Appleton Estate": [],
  "Bulldog Gin": [],
  "Trois Rivères": [],
  "Crodino": [],
  "Averna": ["taverna", "caverna"],
  "Cinzano": [],
  "Riccadonna": [],
  "Kingstone 62": [],
  "Wray & Nephew": [],
  "Glen Grant": [],
}

const SOCIETIES = [
  "Campari",
  "Aperol",
  "Skyyvodka",
  "Wild Turkey",
  "Grand Marnier",
  "Espolon",
  "Appleton Estate",
  "Bulldog Gin",
  "Trois Rivères",
  "Crodino",
  "Averna",
  "Cinzano",
  "Riccadonna",
  "Kingstone 62",
  "Wray & Nephew",
  "Glen Grant",
];

export type Row = {
  '1': string,
  '2': string,
  '3': string,
  '4': string,
  '5': string,
  '6': string,
  '7': string,
  '8': string,
  '9': string,
}

const rowsToString = (rows: Row[]) => {
  let csv = "";

  for (const row of rows) {
    csv += Object.values(row).join(",") + "\n";
  }

  return csv;
}

const appendCsvLines = (rows: Row[]) => {
  const filePath = path.join(Config.get("app.storage.data_folder"), "domains-detailed-found.csv");

  const stream = fs.createWriteStream(filePath, {flags: 'a'})
  stream.write(rowsToString(rows), (err) => {
    if (err) {
      Logger.error(err.message, err.stack);
    }
  });
}

const analyzeCsvRows = async (rows: Row[]) => {
  let toAppend: Row[] = [];

  for (let row of rows) {

    for (const society of SOCIETIES) {
      const excludes: string[] = EXCLUDE[society];

      if (excludes.length > 0) {
        let found = false;
        for (const exclude of excludes) {
          if (fuzz.token_set_ratio(row['1'], exclude.toLowerCase()) > 90) {
            found = true;
            break;
          }
        }

        if (found) {
          continue;
        }
      }

      if (
        fuzz.token_set_ratio(row['1'], society.toLowerCase()) > 85 ||
        fuzz.token_set_ratio(row['1'].split(" ").join(""), society.toLowerCase()) > 85 ||
        fuzz.token_set_ratio(row['1'].split(" ").join("_"), society.toLowerCase()) > 85 ||
        fuzz.token_set_ratio(row['1'].split(" ").join("-"), society.toLowerCase()) > 85
      ) {
        toAppend.push({...row, '9': society});
        break;
      }
    }
  }

  appendCsvLines(toAppend);
}

const handler = async () => {
  const {rows} = loadData<AnalyzeDomainsCsvJobParameters>(["rows"]);
  await analyzeCsvRows(rows);
};

export interface AnalyzeDomainsCsvJobParameters {
  rows: Row[];
}

export default runJob(handler);
