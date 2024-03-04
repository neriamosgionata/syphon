import * as stopword from "stopword";
import {deu, eng, eus, fra, ita, LanguageCode, removeStopwords, spa} from "stopword";
import lodash from "lodash";

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
import crypto from "crypto";
import {Page} from "puppeteer";

import cheerio from 'cheerio';

export interface HelperContract {
  pythonSerializedToJson(pythonObj: string): string;

  cleanText(text: string): string;

  sanitizeWords(words: string): string;

  removeStopwordsJoined(text: string, customStops?: string[]): string;

  removeStopwords(text: string, customStops?: string[]): string[];

  loadInstalledPackageNames(): string[];

  loadInstalledPackage(): Record<string, string>;

  analyzeSentiment(text: string[], lang: AfinnLanguage | PatternLanguage | SenticonLanguage, stemmer: Stemmer, type: AfinnLanguageType | PatternLanguageType | SenticonLanguageType): number;

  analyzeUnknownTextSentiment(text: string[] | string): Promise<number>;

  detectLanguage(text: string | string[]): Promise<Language | null>;

  isNotFalsy<T>(value: T | any): boolean;

  rsAstralRange: string;

  rsComboMarksRange: string;

  reComboHalfMarksRange: string;

  rsComboSymbolsRange: string;

  rsComboMarksExtendedRange: string;

  rsComboMarksSupplementRange: string;

  rsComboRange: string;

  rsDingbatRange: string;

  rsLowerRange: string;

  rsMathOpRange: string;

  rsNonCharRange: string;

  rsPunctuationRange: string;

  rsSpaceRange: string;

  rsUpperRange: string;

  rsVarRange: string;

  rsBreakRange: string;

  rsApos: string;

  rsBreak: string;

  rsCombo: string;

  rsDigit: string;

  rsDingbat: string;

  rsLower: string;

  rsMisc: string;

  rsFitz: string;

  rsModifier: string;

  rsNonAstral: string;

  rsRegional: string;

  rsSurrPair: string;

  rsUpper: string;

  rsZWJ: string;

  rsMiscLower: string;

  rsMiscUpper: string;

  rsOptContrLower: string;

  rsOptContrUpper: string;

  reOptMod: string;

  rsOptVar: string;

  rsOptJoin: string;

  rsOrdLower: string;

  rsOrdUpper: string;

  rsSeq: string;

  rsEmoji: string;

  reUnicodeWords: RegExp;

  hasUnicodeWord: (string: string) => boolean;

  reAsciiWord: RegExp;
  urlRE: RegExp;
  domainRE: RegExp;
  ONE_SECOND: number;
  ONE_MINUTE: number;
  ONE_HOUR: number;
  ONE_DAY: number;
  ONE_WEEK: number;
  ONE_MONTH: number;
  ONE_YEAR: number;
  dateTimeFormat: string;
  dateFormat: string;
  stringMonthFormat: string;

  EQUATORIAL_RADIUS_KM: number;

  unicodeWords(string: string): RegExpMatchArray | null;

  upperFirst(str: string): string;

  asciiWords(string: string): RegExpMatchArray | null;

  words(string: string, pattern?: RegExp | null): RegExpMatchArray;

  camelCase(string: string): string;

  capitalize(str: string): string;

  replaceDiacritics(str: string): string;

  md5(string: string): string;

  sha1(string: string): string;

  wait(ms: number): Promise<unknown>;

  csv2Matrix(csv: string, separator?: string, columnNameParser?: (name: string) => string): any[][];

  arrayShuffle(arr: any[]): any[];

  pick(object: any, keys: string[]): any;

  qs(params: any): string;

  cutout(string: string): string;

  normalizeString(string: string): string;

  sum(array: number[]): number;

  mean(array: number[]): number;

  variance(array: number[]): number;

  isObject(a: any): boolean;

  isFunction(a: any): boolean;

  isUndefined(a: any): boolean;

  isString(a: any): boolean;

  isBoolean(a: any): boolean;

  isNumber(a: any): boolean;

  isFiniteNumber(a: any): boolean;

  map(a: any, cb: (value: any, key: string) => any): any[];

  uniq(array: any[]): any[];

  levenshteinDistance(str1: string, str2: string): number;

  serializeFunction(func: Function): string;

  replaceSymbols(str: string): string;

  substituteAccentedLetters(str: string): string;

  substituteAccentedLettersWithRegexMatch(str: string): string;

  normalizeChefName(chefName: string): string[];

  arrayGetOnlyFirstOneWithElements(...sources: any[][]): any[] | undefined;

  getGoogleSearchStringLocalized(prefix: string, country?: string): string;

  getLocaleString(country?: string): string;

  getBingSearchStringLocalized(prefix: string, country?: string): string;

  formatRecipe(recipe: any): any;

  waitForNetworkIdle(page: Page, timeout: number, maxInflightRequests: number): Promise<unknown>;

  isValued(value: any): boolean;

  sanitizeText(text: string): string;

  toInsensitiveREString(string: string): string;

  toInsensitiveString(string: string): string;

  capitalize(string: string): string;

  toInsensitiveFrags(text?: string): string[];

  countMatches(text: string, frags: string[]): number;

  reOr(names: string[]): string;

  sortByWidth(locations: any[], locationsObj: object): any[];

  failable(callback: Function, attempt?: number, retries?: number): Promise<any>;

  isObject(value: any): boolean;

  findNestedObjectAttribute(element: object, keyToMatch: string, valueToMatch?: any): any;

  mergeDeepNoOverwrite(target: any, ...sources: any[]): { [p: string]: any };

  mergeDeep(target: object, ...sources: any[]): { [p: string]: any };

  rad2degr(rad: number): number;

  degr2rad(degr: number): number;

  isNumeric(str: string): boolean;

  tokenizeSentence(str: string, customStopWords?: string[] | string): string[];
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

  sanitizeWords(words: string): string {
    return StringCleaner
      .setString(words)
      .stripHtml()
      .removeHtmlEntities()
      .removeDashes()
      .removeEscapeCharacters()
      .replace(/[^a-zA-Z\s]+/g, "")
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
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ];
  }

  loadInstalledPackage(): Record<string, string> {
    const file = fs.readFileSync("package.json");
    const packageJson: PackageJson = JSON.parse(file.toString());
    return {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
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

    const detectedLang = await this.detectLanguage(text);

    const lang = (detectedLang?.name || "English") as "English" | "Spanish" | "Portuguese" | "Dutch" | "Italian" | "French" | "German" | "Galician" | "Catalan" | "Basque";
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

  isNotFalsy<T>(value: T | any): boolean {
    return !(value === null || value === undefined || value === "" || isNaN(value));
  }

  /** Used to compose unicode character classes. */
  rsAstralRange = '\\ud800-\\udfff'
  rsComboMarksRange = '\\u0300-\\u036f'
  reComboHalfMarksRange = '\\ufe20-\\ufe2f'
  rsComboSymbolsRange = '\\u20d0-\\u20ff'
  rsComboMarksExtendedRange = '\\u1ab0-\\u1aff'
  rsComboMarksSupplementRange = '\\u1dc0-\\u1dff'
  rsComboRange = this.rsComboMarksRange + this.reComboHalfMarksRange + this.rsComboSymbolsRange + this.rsComboMarksExtendedRange + this.rsComboMarksSupplementRange
  rsDingbatRange = '\\u2700-\\u27bf'
  rsLowerRange = 'a-z\\xdf-\\xf6\\xf8-\\xff'
  rsMathOpRange = '\\xac\\xb1\\xd7\\xf7'
  rsNonCharRange = '\\x00-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\xbf'
  rsPunctuationRange = '\\u2000-\\u206f'
  rsSpaceRange = ' \\t\\x0b\\f\\xa0\\ufeff\\n\\r\\u2028\\u2029\\u1680\\u180e\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u202f\\u205f\\u3000'
  rsUpperRange = 'A-Z\\xc0-\\xd6\\xd8-\\xde'
  rsVarRange = '\\ufe0e\\ufe0f'
  rsBreakRange = this.rsMathOpRange + this.rsNonCharRange + this.rsPunctuationRange + this.rsSpaceRange

  /** Used to compose unicode capture groups. */
  rsApos = '[\'\u2019]'
  rsBreak = `[${this.rsBreakRange}]`
  rsCombo = `[${this.rsComboRange}]`
  rsDigit = '\\d'
  rsDingbat = `[${this.rsDingbatRange}]`
  rsLower = `[${this.rsLowerRange}]`
  rsMisc = `[^${this.rsAstralRange}${this.rsBreakRange + this.rsDigit + this.rsDingbatRange + this.rsLowerRange + this.rsUpperRange}]`
  rsFitz = '\\ud83c[\\udffb-\\udfff]'
  rsModifier = `(?:${this.rsCombo}|${this.rsFitz})`
  rsNonAstral = `[^${this.rsAstralRange}]`
  rsRegional = '(?:\\ud83c[\\udde6-\\uddff]){2}'
  rsSurrPair = '[\\ud800-\\udbff][\\udc00-\\udfff]'
  rsUpper = `[${this.rsUpperRange}]`
  rsZWJ = '\\u200d'

  /** Used to compose unicode regexes. */
  rsMiscLower = `(?:${this.rsLower}|${this.rsMisc})`
  rsMiscUpper = `(?:${this.rsUpper}|${this.rsMisc})`
  rsOptContrLower = `(?:${this.rsApos}(?:d|ll|m|re|s|t|ve))?`
  rsOptContrUpper = `(?:${this.rsApos}(?:D|LL|M|RE|S|T|VE))?`
  reOptMod = `${this.rsModifier}?`
  rsOptVar = `[${this.rsVarRange}]?`
  rsOptJoin = `(?:${this.rsZWJ}(?:${[this.rsNonAstral, this.rsRegional, this.rsSurrPair].join('|')})${this.rsOptVar + this.reOptMod})*`
  rsOrdLower = '\\d*(?:1st|2nd|3rd|(?![123])\\dth)(?=\\b|[A-Z_])'
  rsOrdUpper = '\\d*(?:1ST|2ND|3RD|(?![123])\\dTH)(?=\\b|[a-z_])'
  rsSeq = this.rsOptVar + this.reOptMod + this.rsOptJoin
  rsEmoji = `(?:${[this.rsDingbat, this.rsRegional, this.rsSurrPair].join('|')})${this.rsSeq}`

  reUnicodeWords = RegExp([
    `${this.rsUpper}?${this.rsLower}+${this.rsOptContrLower}(?=${[this.rsBreak, this.rsUpper, '$'].join('|')})`,
    `${this.rsMiscUpper}+${this.rsOptContrUpper}(?=${[this.rsBreak, this.rsUpper + this.rsMiscLower, '$'].join('|')})`,
    `${this.rsUpper}?${this.rsMiscLower}+${this.rsOptContrLower}`,
    `${this.rsUpper}+${this.rsOptContrUpper}`,
    this.rsOrdUpper,
    this.rsOrdLower,
    `${this.rsDigit}+`,
    this.rsEmoji
  ].join('|'), 'g')

  hasUnicodeWord = RegExp.prototype.test.bind(
    /[a-z][A-Z]|[A-Z]{2}[a-z]|\d[a-zA-Z]|[a-zA-Z]\d|[^a-zA-Z0-9 ]/
  )

  /** Used to match words composed of alphanumeric characters. */
  reAsciiWord = /[^\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]+/g
  urlRE = /^(?:http(s)?:\/\/)?[\w.-]+(?:\.[\w.-]+)+[\w\-._~:/?#[\]@!$&'()*+,;=.]+$/i
  domainRE = /^(?!:\/\/)([a-zA-Z0-9-_]+\.)*[a-zA-Z0-9][a-zA-Z0-9-_]+\.[a-zA-Z]{2,11}?$/i
  ONE_SECOND = 1
  ONE_MINUTE = 60 * 1000
  ONE_HOUR = this.ONE_MINUTE * 60
  ONE_DAY = this.ONE_HOUR * 24
  ONE_WEEK = this.ONE_DAY * 7
  ONE_MONTH = this.ONE_DAY * 30
  ONE_YEAR = this.ONE_DAY * 365
  dateTimeFormat = 'YYYY-MM-DD hh:mm:ss'
  dateFormat = 'YYYY-MM-DD'
  stringMonthFormat = 'MMMM'

  EQUATORIAL_RADIUS_KM = 6378.1;

  /**
   * Splits a Unicode `string` into an array of its words.
   *
   * @private
   * @param string
   * @returns {Array} Returns the words of `string`.
   */
  unicodeWords(string: string) {
    return string.match(this.reUnicodeWords)
  }

  upperFirst(str) {
    return `${(str[0] || '').toUpperCase()}${str.slice(1)}`
  }

  asciiWords(string: string) {
    return string.match(this.reAsciiWord)
  }

  words(string, pattern: RegExp | null = null) {
    if (!pattern) {
      const result = this.hasUnicodeWord(string) ? this.unicodeWords(string) : this.asciiWords(string)
      return result || []
    }
    return string.match(pattern) || [];
  }

  camelCase(string: string) {
    return this.words((string + '' || '').replace(/['\u2019]/g, '')).reduce((result, word, index) => {
      word = word.toLowerCase()
      return result + (index ? this.upperFirst(word) : word)
    }, '')
  }

  capitalize(str: string) {
    return str[0].toUpperCase() + str.slice(1);
  }

  replaceDiacritics(str: string) {
    return str.normalize('NFKD')
  }

  md5(string: string) {
    return crypto.createHash('md5').update('' + string).digest('hex')
  }

  sha1(string: string) {
    return crypto.createHash('sha1').update('' + string).digest('hex')
  }

  wait(ms) {
    return new Promise(res => setTimeout(res, ms))
  }

  csv2Matrix(csv, separator, columnNameParser?): any[][] {

    if (typeof csv === 'object') {
      csv = String(csv);
    }

    const defaultColumnNameParser = n => this.camelCase(n.replace('%', 'Perc').replace('#', 'Num'));

    separator = separator || ',';
    columnNameParser = columnNameParser || defaultColumnNameParser;

    const entries: any = [];

    csv = String(csv).replace('\r', '\n');
    csv = csv.replace('\n\n', '\n');

    const rows = csv.split('\n')
      .map(r => r.replace('\r', ''));

    const columnames = rows[0].split(separator).map(columnNameParser);

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i].split(separator);

      if (row.length > 1) {
        // > 0 would take in some blank lines with trash characters on some good old bad csvs
        // unless a better validation is introduced, > 1 is better even if it has the downside of
        // ignoring single column CSVs
        const entry = {};
        for (let ir = 0; ir < row.length; ir++) {
          entry[columnames[ir]] = row[ir];
        }
        entries.push(entry);
      }
    }

    return entries;
  }

  arrayShuffle(arr: any[]): any[] {
    return arr.sort(function () {
      return Math.random() - 0.5;
    });
  }

  pick(object, keys) {
    return keys.reduce((obj, key) => {
      if (object && object.hasOwnProperty(key)) {
        obj[key] = object[key];

        //	obj[key] = key === "_id" ?
        // 		new ObjectId(object[key]) :
        // 		object[key];
      }
      return obj;
    }, {});
  }

  qs(params) {
    let qs = Object.getOwnPropertyNames(params).length ? '?' : ''
    for (const key in params) {
      if (params[key] !== undefined && params[key] !== null) {
        qs += key + '=' + params[key] + '&'
      }
    }
    return qs.replace(/&$/, '')
  }

  cutout(string: string) {
    const replace = replaceString =>
      ((replaceString || '') + '')
        .replace(/^(\t|\n| )+/g, '')
        .replace(/(\t|\n| )+$/g, '')

    return replace(string)
  }

  normalizeString(string: string) {
    return this.cutout(
      (string || '')
        .normalize('NFD')
        .toLowerCase()
        .replace(/[\u0300-\u036f]/g, '')
        // .replace(/[^a-zA-Z0-9 ]/g, ' ') + currency symbols
        .replace(/[^a-zA-Z ]/g, ' ')
        .replace(/[ ]+/g, ' ')
        .replace(/(^ | $)/g, '')
    )
  }

  sum(array) {
    return array.reduce((o, el) => el + o, 0)
  }

  mean(array) {
    return this.sum(array) / array.length
  }

  variance(array) {
    const mean_num = this.mean(array)
    return this.mean(
      array.map(
        (num) => Math.pow(num - mean_num, 2)
      )
    )
  }

  isFunction(a) {
    return a instanceof Function
  }

  isUndefined(a) {
    return a === undefined
  }

  isString(a) {
    return typeof a === 'string'
  }

  isBoolean(a) {
    return typeof a === 'boolean'
  }

  isNumber(a) {
    return typeof a === 'number'
  }

  isFiniteNumber(a) {
    return this.isNumber(a) && isFinite(a)
  }

  map(a, cb) {
    const out: any = []
    for (const key in a) {
      out.push(cb(a[key], key))
    }
    return out
  }

  uniq(array: any[]): any[] {
    return [...new Set(array)];
  }

  levenshteinDistance(str1, str2) {
    const track = Array(str2.length + 1)
      .fill(null)
      .map(() => Array(str1.length + 1).fill(null));

    for (let i = 0; i <= str1.length; i += 1) {
      track[0][i] = i;
    }

    for (let j = 0; j <= str2.length; j += 1) {
      track[j][0] = j;
    }

    for (let j = 1; j <= str2.length; j += 1) {
      for (let i = 1; i <= str1.length; i += 1) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        track[j][i] = Math.min(
          track[j][i - 1] + 1,
          track[j - 1][i] + 1,
          track[j - 1][i - 1] + indicator,
        );
      }
    }

    return track[str2.length][str1.length];
  }

  serializeFunction(func: Function): string {
    let serializedFunc = func.toString();

    function checkIsArrowFunction(fn: Function) {
      if (!fn || typeof fn !== 'function') {
        return false;
      }

      const fnStr = fn.toString();
      let currentIndex: number = 0;
      let openParenCount: number = 0;
      let openBracketCount: number = 0;
      let char: string;
      let charLast: string | undefined;
      let openStringChar: string | undefined;

      while (currentIndex < fnStr.length) {
        char = fnStr[currentIndex];
        if (char === '=' && openParenCount === 0 && openBracketCount === 0 && currentIndex + 1 < fnStr.length && fnStr[currentIndex + 1] === '>') {
          return true;
        } else if (char === '(' && !openStringChar) {
          openParenCount++;
        } else if (char === ')' && !openStringChar) {
          openParenCount--;
        } else if (char === '{' && !openStringChar) {
          openBracketCount++;
        } else if (char === '}' && !openStringChar) {
          openBracketCount--;
        } else if (char === '"' || char === '\'' || char === '`') {
          if (openStringChar && char === openStringChar && charLast !== '\\') {
            openStringChar = undefined;
          } else if (!openStringChar) {
            openStringChar = char;
          }
        }

        charLast = char;
        currentIndex++;
      }

      return false;
    }

    if (!checkIsArrowFunction(func)) {
      serializedFunc = serializedFunc.replace(func.name, "function");
    }

    return serializedFunc.replace(/[\s\t]+/g, ' ').trim();
  }

  replaceSymbols(str: string) {
    return str.replace(/[\[\]*!\-_/\\?:.,()^;]/g, "");
  }

  substituteAccentedLetters(str: string) {
    return str.replace('à', 'a')
      .replace('ä', 'ae')
      .replace('è', 'e')
      .replace('é', 'e')
      .replace('ì', 'i')
      .replace('ò', 'o')
      .replace('ó', 'o')
      .replace('ö', 'oe')
      .replace('ù', 'u')
      .replace('ü', 'ue')
      .replace('ß', 'ss')
      .replace('ú', 'u');
  }

  substituteAccentedLettersWithRegexMatch(str: string) {
    return str.replace('à', '[À-ÖØ-öø-ÿ]+')
      .replace('è', '[À-ÖØ-öø-ÿ]+')
      .replace('é', '[À-ÖØ-öø-ÿ]+')
      .replace('ì', '[À-ÖØ-öø-ÿ]+')
      .replace('ò', '[À-ÖØ-öø-ÿ]+')
      .replace('ó', '[À-ÖØ-öø-ÿ]+')
      .replace('ù', '[À-ÖØ-öø-ÿ]+')
      .replace('ü', '[À-ÖØ-öø-ÿ]+')
      .replace('ß', '[À-ÖØ-öø-ÿ]+')
      .replace('ú', '[À-ÖØ-öø-ÿ]+');
  }

  normalizeChefName(chefName: string): string[] {
    const chefsS = chefName.includes(' / ') ? chefName.split(' / ') : [];
    const chefsE = chefName.includes(' e ') ? chefName.split(' e ') : [];
    const chefsC = chefName.includes(' con ') ? chefName.split(' con ') : [];
    const chefsA = chefName.includes(' and ') ? chefName.split(' and ') : [];
    const chefsEC = chefName.includes(' & ') ? chefName.split(' & ') : [];
    const chefsV = chefName.includes(', ') ? chefName.split(', ') : [];

    let chefs: string[] = this.arrayGetOnlyFirstOneWithElements(chefsS, chefsE, chefsC, chefsA, chefsV, chefsEC) || [];

    if (chefs.length) {
      for (let i = 0; i < chefs.length; i++) {
        const normalized = this.normalizeChefName(chefs[i]);
        chefs.splice(i, 1);
        chefs = [...chefs, ...normalized];
      }
    } else {
      chefs = [chefName];
    }

    return this.uniq(chefs);
  }

  arrayGetOnlyFirstOneWithElements(...sources: any[][]): any[] | undefined {
    return sources.find((source) => source.length > 0)
  }

  getGoogleSearchStringLocalized(prefix, country = 'en-gb') {
    let tld;
    let locales;
    let countryRef;

    switch (country.toLowerCase()) {
      case 'it':
      case 'it-it':
      case 'italy':
        tld = '.it';
        locales = 'it-IT,it';
        countryRef = 'countryIT';
        break;
      case 'de':
      case 'de-de':
      case 'germany':
        tld = '.de';
        locales = 'de-DE,de';
        countryRef = 'countryDE';
        break;
      case 'gb':
      case 'en-gb':
      case 'united kingdom':
        tld = '.co.uk';
        locales = 'en-GB,en';
        countryRef = 'countryGB';
        break;
      case 'fr':
      case 'fr-fr':
      case 'france':
        tld = '.fr';
        locales = 'fr-FR,fr';
        countryRef = 'countryFR';
        break;
      case 'es':
      case 'es-es':
      case 'spain':
        tld = '.es';
        locales = 'es-ES,es';
        countryRef = 'countryES';
        break;
      case 'en-us':
      case 'us':
      case 'united states':
      default:
        tld = '.com';
        locales = 'en-US,en';
        countryRef = 'countryUS';
        break;
    }

    const lang = locales.slice(0, 2);

    // lr = lang_fr & gl = fr & cr = countryFR & hl = fr & ie = UTF - 8 & no_sw_cr = 1 & pws = 0
    return prefix + tld + '/?lr=lang_' + lang + '&gl=' + lang + '&cr=' + countryRef + '&hl=' + lang + '&ie=UTF-8&no_sw_cr=1&pws=0';
  }

  getLocaleString(country = 'en-gb') {
    switch (country.toLowerCase()) {
      case 'it':
      case 'it-it':
      case 'italy':
        return 'it-IT,it';
      case 'de':
      case 'de-de':
      case 'germany':
        return 'de-DE,de';
      case 'gb':
      case 'en-gb':
      case 'united kingdom':
        return 'en-GB,en';
      case 'fr':
      case 'fr-fr':
      case 'france':
        return 'fr-FR,fr';
      case 'es':
      case 'es-es':
      case 'spain':
        return 'es-ES,es';
      case 'en-us':
      case 'us':
      case 'united states':
      default:
        return 'en-US,en';
    }
  }

  getBingSearchStringLocalized(prefix, country = 'en-gb') {
    let tld;
    let locales;

    switch (country.toLowerCase()) {
      case 'it':
      case 'it-it':
      case 'italy':
        tld = '.it';
        locales = 'it-IT,it';
        break;
      case 'de':
      case 'de-de':
      case 'germany':
        tld = '.de';
        locales = 'de-DE,de';
        break;
      case 'gb':
      case 'en-gb':
      case 'united kingdom':
        tld = '.co.uk';
        locales = 'en-GB,en';
        break;
      case 'fr':
      case 'fr-fr':
      case 'france':
        tld = '.fr';
        locales = 'fr-FR,fr';
        break;
      case 'es':
      case 'es-es':
      case 'spain':
        tld = '.es';
        locales = 'es-ES,es';
        break;
      case 'en-us':
      case 'us':
      case 'united states':
      default:
        tld = '.com';
        locales = 'en-US,en';
    }

    const lang = locales.slice(0, 2);
    const locale = locales.slice(0, 5);

    return prefix + tld + '/?mkt=' + locale + '&setLang=' + lang.toUpperCase()
  }

  formatRecipe(recipe) {
    try {
      if (recipe.name) {
        recipe.name = this.sanitizeText(recipe.name)
      }
      if (recipe.author && recipe.author.name) {
        recipe.author.name = this.sanitizeText(recipe.author.name)
      }
      if (recipe.description) {
        recipe.description = this.sanitizeText(recipe.description)
      }
      if (recipe.recipeCuisine && recipe.recipeCuisine.length) {
        if (Array.isArray(recipe.recipeCuisine)) {
          recipe.recipeCuisine = recipe.recipeCuisine.map(this.sanitizeText)
        } else {
          recipe.recipeCuisine = [this.sanitizeText(recipe.recipeCuisine)]
        }
      }
      if (recipe.recipeCategory && recipe.recipeCategory.length) {
        if (Array.isArray(recipe.recipeCategory)) {
          recipe.recipeCategory = recipe.recipeCategory.map(this.sanitizeText)
        } else {
          recipe.recipeCategory = [this.sanitizeText(recipe.recipeCategory)]
        }
      }
      if (recipe.recipeIngredient && recipe.recipeIngredient.length) {
        if (recipe.recipeIngredient.map) {
          recipe.recipeIngredient = recipe.recipeIngredient.map(this.sanitizeText)
        } else {
          recipe.recipeIngredient = [this.sanitizeText(recipe.recipeIngredient)]
        }
      }
      if (recipe.totalTime && this.isString(recipe.totalTime)) {
        const timeChars = recipe.totalTime.toUpperCase().split(/(P|D|T|H|M|S)/).filter(x => x).slice(1).filter(x => x != 'T')
        let s_i = 0
        const timeStrings: any = [[], [], [], []]
        for (const char of timeChars) {
          if (!char.match(/[A-Z]/)) {
            s_i += 1
          } else {
            timeStrings[s_i].push(char)
          }
        }
        const timeValues = timeStrings.map(x => parseInt(x.join('')) || 0)
        recipe.totalTime = (
          timeValues[0] * this.ONE_DAY
          + timeValues[1] * this.ONE_HOUR
          + timeValues[2] * this.ONE_MINUTE
          + timeValues[3] * this.ONE_SECOND
        )
      }
      if (recipe.aggregateRating && this.isObject(recipe.aggregateRating)) {
        recipe.aggregateRating.ratingValue = parseInt(recipe.aggregateRating.ratingValue) || 0
        recipe.aggregateRating.ratingCount = parseInt(recipe.aggregateRating.ratingCount) || 0
        recipe.aggregateRating.bestRating = parseInt(recipe.aggregateRating.bestRating) || 5
        recipe.aggregateRating.worstRating = parseInt(recipe.aggregateRating.worstRating) || 1
      }
      return recipe;
    } catch (e) {
      return false;
    }
  }

  waitForNetworkIdle(page: Page, timeout) {
    let fulfillPromiseFunction: ((value: unknown) => void) | null;

    const promise = new Promise((resolve) => {
      fulfillPromiseFunction = resolve
    })

    const removeListenersFromRequestEvents = () => {
      page.removeAllListeners('requestfinished');
      page.removeAllListeners('requestfailed');
    }

    removeListenersFromRequestEvents();

    const sharedEndSequence = () => {
      removeListenersFromRequestEvents();
      // @ts-ignore
      fulfillPromiseFunction(true);
      clearTimeout(timeoutId);
    }

    const requestFinished = () => {
      sharedEndSequence();
    }

    const requestFailed = () => {
      sharedEndSequence();
    }

    const timeoutExpired = () => {
      sharedEndSequence();
    }

    const timeoutId = setTimeout(timeoutExpired, timeout);

    page.on('requestfinished', requestFinished);
    page.on('requestfailed', requestFailed);

    return promise
  }

  isValued(value: any): boolean {
    return value !== null && value !== undefined && value !== '' && value !== 'null' && value !== 'undefined' && value !== 'NaN' && value !== 'nan' && value !== 'none';
  }

  sanitizeText(string) {
    return cheerio.load(string).text().toLowerCase()
  }


  toInsensitiveREString(string): string {
    return string.toLowerCase()
      .replace("a", "[aăàáâãäå]")
      .replace("b", "[bþ]")
      .replace("c", "[c¢Ç]")
      .replace("e", "[eèéêëē]")
      .replace("f", "[fƒ]")
      .replace("i", "[iìîíï]")
      .replace("n", "[nñ]")
      .replace("o", "[oðòóôõöø]")
      .replace("s", "[sš]")
      .replace("u", "[uµùúûüü]")
      .replace("y", "[yý]")
      .replace("z", "[zž]")
  }

  toInsensitiveString(string): string {
    return string.toLowerCase()
      .replace(/[aăàáâãäå]/g, "a")
      .replace(/[bþ]/g, "b")
      .replace(/[c¢Ç]/g, "c")
      .replace(/[eèéêëē]/g, "e")
      .replace(/[fƒ]/g, "f")
      .replace(/[iìîíï]/g, "i")
      .replace(/[nñ]/g, "n")
      .replace(/[oðòóôõöø]/g, "o")
      .replace(/[sš]/g, "s")
      .replace(/[uµùúûüü]/g, "u")
      .replace(/[yý]/g, "y")
      .replace(/[zž]/g, "z")
  }

  toInsensitiveFrags(text: string = ""): string[] {
    return this.toInsensitiveString(text).replace(/['"|,.;]/, ' ').replace(/[\s\n\t\r]+/g, ' ').split(' ')
  }

  countMatches(text: string, frags: string[]): number {
    return frags.filter(frag => this.toInsensitiveString(text).indexOf(frag) > -1).length
  }

  reOr(names: string[]): string {
    return '(' + names.join('|') + ')'
  }

  sortByWidth(locations: any[], locationsObj: any): any[] {
    return locations
      .reduce((o, v) => {
        const i = locationsObj[v] - 1
        o[i].push(v)
        return o
      }, [[], [], [], [], []])
      .flatMap(x => x.sort((a, b) => a.localeCompare(b)))
  }

  async failable(callback: Function, attempt: number = 0, retries: number = 3): Promise<any> {
    let result: any = null;

    try {
      result = await callback();
    } catch (err) {
      if (attempt < retries) {
        return this.failable(callback, attempt + 1, retries);
      }

      throw err;
    }

    return result;
  }

  isObject(value: any) {
    return value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
  }

  findNestedObjectAttribute(element: object, keyToMatch: string, valueToMatch: any = undefined): any {
    if (keyToMatch === undefined || keyToMatch === null || keyToMatch === "") {
      throw new Error("key to match is not valid");
    }

    if (!this.isObject(element)) {
      throw new Error("element is not an object");
    }

    const entries = Object.entries(element);

    for (const element of entries) {
      const [elementKey, elementValue] = element;

      if (elementKey === keyToMatch && (valueToMatch === undefined || lodash.isEqual(elementValue, valueToMatch))) {
        return element;
      }

      if (this.isObject(elementValue)) {
        const child = this.findNestedObjectAttribute(elementValue, keyToMatch, valueToMatch);

        if (child !== null) {
          return child;
        }
      }
    }

    return null;
  }

  mergeDeepNoOverwrite(target: any, ...sources: any[]): { [p: string]: any } {
    if (!sources?.length) {
      return target;
    }

    const source = sources.shift();

    if (this.isObject(target)) {
      for (const key in Object.keys(source)) {
        if (this.isObject(source[key])) {
          target[key] = this.mergeDeepNoOverwrite(target[key], source[key]);
        } else {
          if (this.isValued(target[key]) && this.isValued(source[key])) {
            target[key] = source[key];
          }
        }
      }
    }

    return this.mergeDeepNoOverwrite(target, ...sources);
  }

  mergeDeep(target: object, ...sources: any[]): { [p: string]: any } {
    if (!sources?.length) {
      return target;
    }

    const source = sources.shift();

    if (this.isObject(target) && this.isObject(source)) {
      for (const key in source) {
        if (this.isObject(source[key])) {
          if (!target[key]) {
            Object.assign(target, {[key]: {}});
          }
          target[key] = this.mergeDeep(target[key], source[key]);
        } else {
          if (this.isValued(source[key])) {
            Object.assign(target, {[key]: source[key]});
          }
        }
      }
    }

    return this.mergeDeep(target, ...sources);
  }

  rad2degr(rad: number) {
    return rad * 180 / Math.PI;
  }

  degr2rad(degr: number) {
    return degr * Math.PI / 180;
  }

  isNumeric(str: any) {
    if (typeof str !== "string") {
      return false
    }

    // @ts-ignore
    return !isNaN(str) && !isNaN(parseFloat(str));
  }

  tokenizeSentence(str: string, customStopWords?: string[] | string): string[] {
    let stopWordChoosen: string[] = [];

    if (typeof customStopWords === "string") {
      stopWordChoosen = stopword[customStopWords];
    } else {
      stopWordChoosen = customStopWords || [...ita, ...eng, ...deu, ...spa, ...fra, ...eus];
    }

    const tokenizer = new natural.WordTokenizer();
    return removeStopwords((tokenizer.tokenize(str) || []), stopWordChoosen);
  }

}
