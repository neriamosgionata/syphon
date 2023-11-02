import {BaseJobParameters, loadData, logMessage, runJob} from "App/Services/Jobs/JobHelpers";
import fs from "fs";
import fuzz from "fuzzball";
import Config from "@ioc:Adonis/Core/Config";
import path from "path";

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
  '10': string,
}

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

const rowsToString = (rows: Row[]) => {
  let csv = "";

  for (const row of rows) {
    csv += Object.values(row).join(",") + "\n";
  }

  return csv;
}

const appendCsvLines = (rows: Row[]) => {
  const filePath = path.join(Config.get("app.storage.data_folder"), "domains-detailed-matched.csv");

  const stream = fs.createWriteStream(filePath, {flags: 'a'})
  stream.write(rowsToString(rows), (err) => {
    if (err) {
      logMessage(err.message, "error", err);
    }
  });
  stream.end();
}

const analyzeCsvRows = (rows: Row[], toMatch: { "1": string, "2": string }[]) => {
  let toAppend: Row[] = [];

  for (let row of rows) {
    const row1Lower = row['1'].toLowerCase();
    const row2Lower = row['2'].toLowerCase();

    for (const society of toMatch) {
      const excludes: string[] = EXCLUDE[society["1"]];

      if (excludes?.length > 0) {
        let found = false;

        for (const exclude of excludes) {
          if (
            fuzz.token_set_ratio(row1Lower, exclude.toLowerCase()) > 85 ||
            fuzz.token_set_ratio(row2Lower, exclude.toLowerCase()) > 85
          ) {
            found = true;
            break;
          }
        }

        if (found) {
          continue;
        }
      }

      if (
        fuzz.token_set_ratio(row1Lower, society["2"]) >= 65 ||
        fuzz.token_set_ratio(row2Lower, society["2"]) >= 65
      ) {
        toAppend.push({
          '1': society["1"],
          '2': society["2"],
          '3': row['1'] || "",
          '4': row['2'] || "",
          '5': row['3'] || "",
          '6': row['4'] || "",
          '7': row['5'] || "",
          '8': row['6'] || "",
          '9': row['7'] || "",
          '10': row['8'] || "",
        });
        break;
      }
    }
  }

  appendCsvLines(toAppend);
}

const handler = () => {
  const {rows, toMatch} = loadData<MatchDomainsCsvJobParameters>(["rows", "toMatch"]);
  analyzeCsvRows(rows, toMatch);
};

export interface MatchDomainsCsvJobParameters extends BaseJobParameters {
  rows: Row[];
  toMatch: { "1": string, "2": string }[];
}

export default runJob(handler);
