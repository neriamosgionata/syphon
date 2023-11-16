import {deu, eng, eus, fra, ita, removeStopwords, spa} from "stopword";
import natural from "natural";
import StringCleaner from "@ioc:Providers/StringCleaner";
import fs from "fs";
import PackageJson from "App/Models/PackageJson";

export interface HelperContract {
  pythonSerializedToJson(pythonObj: string): string;

  cleanText(text: string): string;

  removeStopwords(text: string, customStops?: string[]): string;

  loadInstalledPackageNames(): string[];

  loadInstalledPackage(): Record<string, string>;
}


export default class Helper implements HelperContract {
  pythonSerializedToJson(pythonObj: string): string {
    return pythonObj.replaceAll(/'/g, '"')
      .replaceAll(/True/g, 'true')
      .replaceAll(/False/g, 'false')
      .replaceAll(/None/g, 'null')
      .replaceAll(/\\n/g, '\n')
      .replaceAll(/\\'/g, "'")
      .replaceAll(/\\"/g, '"')
  }

  cleanText(text: string): string {
    return StringCleaner
      .setString(text)
      .stripHtml()
      .removeHtmlEntities()
      .removeDashes()
      .toLowerCase()
      .valueOf()
  }

  removeStopwords(text: string, customStops?: string[]): string {
    const stops: string[] = customStops || [...ita, ...eng, ...deu, ...spa, ...fra, ...eus];
    const tokenizer = new natural.WordTokenizer();
    return removeStopwords((tokenizer.tokenize(text) || []), stops).join(" ");
  }

  loadInstalledPackageNames(): string[] {
    const file = fs.readFileSync("package.json");
    const packageJson: PackageJson = JSON.parse(file.toString());
    return [
      ...Object.keys(packageJson.dependencies),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ];
  }

  loadInstalledPackage(): Record<string, string> {
    const file = fs.readFileSync("package.json");
    const packageJson: PackageJson = JSON.parse(file.toString());
    return {
      ...packageJson.dependencies,
      ...packageJson.devDependencies ?? {},
    };
  }

}
