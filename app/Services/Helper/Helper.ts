import {deu, eng, eus, fra, ita, LanguageCode, removeStopwords, spa} from "stopword";
import natural, {
  AfinnLanguage,
  AfinnLanguageType,
  PatternLanguageType,
  PorterStemmer,
  SenticonLanguageType,
  SentimentAnalyzer,
  Stemmer
} from "natural";
import StringCleaner from "@ioc:Providers/StringCleaner";
import fs from "fs";
import PackageJson from "App/Models/PackageJson";
import {PatternLanguage, SenticonLanguage} from "natural/lib/natural/sentiment";
import cld, {Language} from "cld";

export interface HelperContract {
  pythonSerializedToJson(pythonObj: string): string;

  cleanText(text: string): string;

  removeStopwordsJoined(text: string, customStops?: string[]): string;

  removeStopwords(text: string, customStops?: string[]): string[];

  loadInstalledPackageNames(): string[];

  loadInstalledPackage(): Record<string, string>;

  analyzeSentiment(text: string[], lang: AfinnLanguage | PatternLanguage | SenticonLanguage, stemmer: Stemmer, type: AfinnLanguageType | PatternLanguageType | SenticonLanguageType): number;

  analyzeUnknownTextSentiment(text: string[] | string): Promise<number>;

  detectLanguage(text: string | string[]): Promise<Language | null>;
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

  analyzeSentiment(text: string[], lang: AfinnLanguage | PatternLanguage | SenticonLanguage, stemmer: Stemmer, type: AfinnLanguageType | PatternLanguageType | SenticonLanguageType): number {
    //@ts-ignore
    const analyzer = new SentimentAnalyzer(lang, stemmer, type);
    return analyzer.getSentiment(text);
  }

  async analyzeUnknownTextSentiment(text: string[] | string) {
    if (!Array.isArray(text)) {
      text = text.split(" ");
    }

    let detectedLang = await this.detectLanguage(text);

    let lang = (detectedLang?.name || "English") as "English" | "Spanish" | "Portuguese" | "Dutch" | "Italian" | "French" | "German" | "Galician" | "Catalan" | "Basque";
    let type = "afinn" as "afinn" | "pattern" | "senticon";

    if (['English', 'Spanish', 'Portuguese'].includes(lang)) {
      type = "afinn";
    } else if (['Spanish', 'English', 'Galician', 'Catalan', 'Basque'].includes(lang)) {
      type = "senticon";
    } else if (['Dutch', 'Italian', 'English', 'French', 'German'].includes(lang)) {
      type = "pattern";
    }

    return this.analyzeSentiment(text, lang, PorterStemmer, type);
  }

  async detectLanguage(text: string | string[]): Promise<Language | null> {
    if (Array.isArray(text)) {
      text = text.join(" ");
    }

    const result = await cld.detect(text);

    return result.languages.length > 0 ? result.languages[0] : null;
  }

}
