import {deu, eng, eus, fra, ita, LanguageCode, removeStopwords, spa} from "stopword";
import natural, {AfinnLanguage, AfinnLanguageType, PatternLanguageType, SentimentAnalyzer, Stemmer} from "natural";
import StringCleaner from "@ioc:Providers/StringCleaner";
import fs from "fs";
import PackageJson from "App/Models/PackageJson";
import {PatternLanguage} from "natural/lib/natural/sentiment";

export interface HelperContract {
  pythonSerializedToJson(pythonObj: string): string;

  cleanText(text: string): string;

  removeStopwordsJoined(text: string, customStops?: string[]): string;

  removeStopwords(text: string, customStops?: string[]): string[];

  loadInstalledPackageNames(): string[];

  loadInstalledPackage(): Record<string, string>;

  analyzeSentiment(text: string[], lang: AfinnLanguage | PatternLanguage, stemmer: Stemmer, type: AfinnLanguageType | PatternLanguageType): number;
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
      .aposToLexForm()
      .replace(/[^a-zA-Z\s]+/g, "")
      .fixSpellingErrors()
      .toLowerCase()
      .valueOf()
  }

  removeStopwordsJoined(text: string, customStops?: LanguageCode[]): string {
    return this.removeStopwords(text, customStops).join(" ");
  }

  removeStopwords(text: string, customStops?: LanguageCode[]): string[] {
    const stops: LanguageCode[] = customStops || [...ita, ...eng, ...deu, ...spa, ...fra, ...eus] as unknown as LanguageCode[];
    const tokenizer = new natural.WordTokenizer();
    return removeStopwords((tokenizer.tokenize(text) || []), stops);
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

  analyzeSentiment(text: string[], lang: AfinnLanguage | PatternLanguage, stemmer: Stemmer, type: AfinnLanguageType | PatternLanguageType): number {
    //@ts-ignore
    const analyzer = new SentimentAnalyzer(lang, stemmer, type);
    return analyzer.getSentiment(text);
  }

}
