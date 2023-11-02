import anglicize from "anglicize";
import ent from "ent";
import phoneRegex from "phone-regex";
import stopword from "stopword";


export interface StringCleanerContract {
  valueOf(): string;

  toString(): string;

  get length(): number;

  remove(search: string | RegExp): StringCleanerContract;

  replace(search: string | RegExp, replace: string): StringCleanerContract;

  trim(): StringCleanerContract;

  toLowerCase(): StringCleanerContract;

  toUpperCase(): StringCleanerContract;

  truncate(len: number): StringCleanerContract;

  condense(): StringCleanerContract;

  stripEmails(): StringCleanerContract;

  stripHtml(): StringCleanerContract;

  stripPhoneNumbers(): StringCleanerContract;

  anglicize(): StringCleanerContract;

  removeChars(options?: { replaceWith?: string; exclude?: string }): StringCleanerContract;

  removeApostrophes(): StringCleanerContract;

  removeStopWords(): StringCleanerContract;

  decodeHtmlEntities(): StringCleanerContract;

  removeHtmlEntities(): StringCleanerContract;

  removeDashes(): StringCleanerContract;

  setString(s: string): StringCleanerContract;
}

export default class StringCleaner implements StringCleanerContract {
  private s: string;

  constructor() {
  }

  setString(s: string): StringCleanerContract {
    this.s = s;
    return this;
  }

  valueOf(): string {
    return this.toString();
  }

  toString(): string {
    return this.s;
  }

  get length(): number {
    return this.s.length;
  }

  remove(search: string | RegExp): StringCleanerContract {
    return this.replace(search, "");
  }

  replace(search: string | RegExp, replace: string): StringCleanerContract {
    this.s = this.s.replace(search, replace);
    return this;
  }

  trim(): StringCleanerContract {
    this.s = this.s.trim();
    return this;
  }

  toLowerCase(): StringCleanerContract {
    this.s = this.s.toLowerCase();
    return this;
  }

  toUpperCase(): StringCleanerContract {
    this.s = this.s.toUpperCase();
    return this;
  }

  truncate(len: number): StringCleanerContract {
    this.s = this.s.substring(0, len);
    return this;
  }

  condense(): StringCleanerContract {
    return this.trim().replace(/\s+/g, " ");
  }

  stripEmails(): StringCleanerContract {
    const emailRegex = require("email-regex");
    return this.remove(emailRegex());
  }

  stripHtml(): StringCleanerContract {
    const striptags = require("striptags");
    this.s = striptags(this.s);
    return this;
  }

  stripPhoneNumbers(): StringCleanerContract {
    return this.remove(phoneRegex());
  }

  anglicize(): StringCleanerContract {
    this.s = anglicize(this.s);
    return this;
  }

  removeChars(options: { replaceWith?: string; exclude?: string } = {}): StringCleanerContract {
    const opts = Object.assign(
      {
        replaceWith: "",
        exclude: "",
      },
      options
    );

    const escapeStringRegexp = require("escape-string-regexp");

    const re = new RegExp(
      `[^a-z\\s${escapeStringRegexp(opts.exclude)} ]`,
      "gi"
    );

    return this.replace(re, opts.replaceWith);
  }

  removeApostrophes(): StringCleanerContract {
    const re = /[a-z]('|`|’)[a-z]/gi;
    let match = re.exec(this.s);

    while (match !== null) {
      this.s = this.s.substring(0, match.index + 1) +
        this.s.substring(match.index + 2, this.s.length);

      match = re.exec(this.s);
    }

    return this;
  }

  removeStopWords(): StringCleanerContract {
    this.s = stopword.removeStopwords(this.s.split(" ")).join(" ");
    return this;
  }

  decodeHtmlEntities(): StringCleanerContract {
    this.s = ent.decode(this.s);
    return this;
  }

  removeHtmlEntities(): StringCleanerContract {
    return this.remove(/&[#0-9a-z]+;/gi);
  }

  removeDashes(): StringCleanerContract {
    const re = /((^|[^a-z])-+|-+([^a-z]|$))/gi;
    let match = re.exec(this.s);

    while (match !== null) {
      this.s = this.s.substring(0, match.index) +
        match[0].replace(/-/g, "") +
        this.s.substring(match.index + match[0].length, this.s.length);

      match = re.exec(this.s);
    }

    return this;
  }
}
