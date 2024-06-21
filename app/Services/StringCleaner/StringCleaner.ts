import anglicize from "anglicize";
import ent from "ent";
import phoneRegex from "phone-regex";
import stopword from "stopword";
import aposToLexForm from "apos-to-lex-form";
import spellingCorrector from "spelling-corrector";
import stripTags from "striptags";

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

    removeEscapeCharacters(): StringCleanerContract;

    removeDashes(): StringCleanerContract;

    setString(s: string): StringCleanerContract;

    aposToLexForm(): StringCleanerContract;

    fixSpellingErrors(): StringCleanerContract;

    sanitizeWords(words: string): string;
}

export default class StringCleaner implements StringCleanerContract {
    private s: string;

    constructor() {
    }

    emailRegex = '[^\\.\\s@:](?:[^\\s@:]*[^\\s@:\\.])?@[^\\.\\s@]+(?:\\.[^\\.\\s@]+)*';

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
        return this.remove(new RegExp(`^${this.emailRegex}$`));
    }

    stripHtml(): StringCleanerContract {
        this.s = stripTags(this.s);
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

        const re = new RegExp(
            `[^a-z\\s${opts.exclude
		.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
		.replace(/-/g, '\\x2d')} ]`,
            "gi"
        );

        return this.replace(re, opts.replaceWith);
    }

    removeApostrophes(): StringCleanerContract {
        const re = /[a-z](['`’])[a-z]/gi;
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
        return this.remove(/(&[#0-9a-z]+;)|( )/gi);
    }

    removeEscapeCharacters(): StringCleanerContract {
        return this.remove(/\//gi);
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

    aposToLexForm(): StringCleanerContract {
        this.s = aposToLexForm(this.s);
        return this;
    }

    fixSpellingErrors(): StringCleanerContract {
        this.s = spellingCorrector(this.s);
        return this;
    }

    sanitizeWords(words: string): string {
        return this
            .setString(words)
            .stripHtml()
            .removeHtmlEntities()
            .removeDashes()
            .removeEscapeCharacters()
            .replace(/[^a-zA-Z\s]+/g, "")
            .valueOf()
    }
}
