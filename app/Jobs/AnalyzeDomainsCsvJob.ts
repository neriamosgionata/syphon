import {loadData, logMessage, runJob} from "App/Services/Jobs/JobHelpers";
import fs from "fs";
import fuzz from "fuzzball";
import Config from "@ioc:Adonis/Core/Config";
import path from "path";

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
      logMessage(err.message, "error", err);
    }
  });
  stream.end();
}

const analyzeCsvRows = (rows: Row[]) => {
  let toAppend: Row[] = [];

  for (let row of rows) {
    const row1Lower = row['1'].toLowerCase();
    const row2LowerSplit1 = row1Lower.split(" ").join("");
    const row2LowerSplit2 = row1Lower.split(" ").join("_");
    const row2LowerSplit3 = row1Lower.split(" ").join("-");

    for (const society of SOCIETIES) {
      const societyLower = society.toLowerCase();
      const excludes: string[] = EXCLUDE[society];

      if (excludes.length > 0) {
        let found = false;
        for (const exclude of excludes) {
          if (fuzz.token_set_ratio(row1Lower, exclude.toLowerCase()) > 85) {
            found = true;
            break;
          }
        }

        if (found) {
          continue;
        }
      }

      if (
        fuzz.token_set_ratio(row1Lower, societyLower) > 85 ||
        fuzz.token_set_ratio(row2LowerSplit1, societyLower) > 85 ||
        fuzz.token_set_ratio(row2LowerSplit2, societyLower) > 85 ||
        fuzz.token_set_ratio(row2LowerSplit3, societyLower) > 85
      ) {
        toAppend.push({
          '1': row['1'] || "",
          '2': row['2'] || "",
          '3': row['3'] || "",
          '4': row['4'] || "",
          '5': row['5'] || "",
          '6': row['6'] || "",
          '7': row['7'] || "",
          '8': row['8'] || "",
          '9': society
        });
        break;
      }
    }
  }

  appendCsvLines(toAppend);
}

const handler = () => {
  const {rows} = loadData<AnalyzeDomainsCsvJobParameters>(["rows"]);
  analyzeCsvRows(rows);
};

export interface AnalyzeDomainsCsvJobParameters {
  rows: Row[];
}

export default runJob(handler);
