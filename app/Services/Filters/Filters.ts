import {
  BooleanAndSym,
  BooleanOrSym,
  ClosingBracket,
  Filter,
  FilterSplitter,
  OpeningBracket,
  Operators
} from "App/Models/Filter";
import {LucidModel, ModelQueryBuilderContract} from "@ioc:Adonis/Lucid/Orm";

export interface FiltersContract {
  parseQueryString<T extends LucidModel>(queryFilterString: string): Filter<T>;

  resolveFilter<T extends LucidModel>(filter: Filter<any>, query: ModelQueryBuilderContract<T, InstanceType<T> | InstanceType<T>[]>): ModelQueryBuilderContract<T, InstanceType<T>>;
}

export default class Filters implements FiltersContract {

  private parseSingleFilterBlock<T extends LucidModel>(filterString: string): Filter<T> {
    const splitted = filterString.split(FilterSplitter);
    if (![2, 3].includes(splitted.length)) {
      throw new Error("Error parsing filter: invalid number of arguments for single filter");
    }

    const operatorSymbol = splitted[1];

    if (splitted.length === 3) {
      return {
        filterAttribute: splitted[0],
        filterValue: splitted[2],
        operator: Operators[operatorSymbol],
        nested: false,
        nestedFilter: [],
      } as Filter<T>;
    }

    return {
      filterAttribute: splitted[0],
      filterValue: null,
      operator: Operators[operatorSymbol],
      nested: false,
      nestedFilter: [],
    } as Filter<T>;
  }

  private parseAndFilterBlocks<T extends LucidModel>(filterString: string): Filter<T> {
    const splitted = filterString.split(BooleanAndSym);

    if (splitted.length <= 1) {
      throw new Error("Error parsing filter: AND not valid");
    }

    const filter = {
      filterAttribute: "",
      filterValue: null,
      operator: Operators[BooleanAndSym],
      nested: true,
      nestedFilter: [],
    } as Filter<T>;

    for (const partialQueryString of splitted) {
      const nestedFilter = this.parseParentheses<T>(partialQueryString);
      filter.nestedFilter.push(nestedFilter);
    }

    return filter;
  }

  private parseOrFilterBlocks<T extends LucidModel>(filterString: string): Filter<T> {
    const splitted = filterString.split(BooleanOrSym);

    if (splitted.length <= 1) {
      throw new Error("Error parsing filter: OR not valid");
    }

    const filter = {
      filterAttribute: "",
      filterValue: null,
      operator: Operators[BooleanOrSym],
      nested: true,
      nestedFilter: [],
    } as Filter<T>;

    for (const partialQueryString of splitted) {
      const nestedFilter = this.parseParentheses<T>(partialQueryString);
      filter.nestedFilter.push(nestedFilter);
    }

    return filter;
  }

  private parseSingleFilter<T extends LucidModel>(filterString: string): Filter<T> {
    if (filterString.indexOf(BooleanAndSym) !== -1) {
      return this.parseAndFilterBlocks<T>(filterString);
    }

    if (filterString.indexOf(BooleanOrSym) !== -1) {
      return this.parseOrFilterBlocks<T>(filterString);
    }

    if (filterString.indexOf(FilterSplitter)) {
      return this.parseSingleFilterBlock<T>(filterString);
    }

    throw new Error("Error parsing filter");
  }

  private parseParentheses<T extends LucidModel>(queryFilterString: string): Filter<T> {
    if (queryFilterString.indexOf(OpeningBracket) === -1) {
      return this.parseSingleFilter<T>(queryFilterString);
    }
    let openingBracketIndex = queryFilterString.indexOf(OpeningBracket);

    if (queryFilterString.indexOf(ClosingBracket) === -1) {
      throw new Error("Closing bracket not found");
    }
    let closingBracketIndex = queryFilterString.indexOf(ClosingBracket);

    return this.parseParentheses<T>(
      queryFilterString.substring(openingBracketIndex + 1, closingBracketIndex)
    );
  }

  parseQueryString<T extends LucidModel>(queryFilterString: string): Filter<T> {
    return this.parseParentheses<T>(queryFilterString);
  }

  resolveFilter<T extends LucidModel>(filter: Filter<T>, query: ModelQueryBuilderContract<T, InstanceType<T>>): ModelQueryBuilderContract<T, InstanceType<T>> {
    if (filter.nested) {
      if (filter.operator.symbol === BooleanAndSym) {
        query.where((q: ModelQueryBuilderContract<T, InstanceType<T>>) => {
          for (const nestedFilter of filter.nestedFilter) {
            q.andWhere((qq: ModelQueryBuilderContract<T, InstanceType<T>>) => {
              this.resolveFilter<T>(nestedFilter, qq);
            });
          }
        });
        return query;
      }

      if (filter.operator.symbol === BooleanOrSym) {
        query.where((q: ModelQueryBuilderContract<T, InstanceType<T>>) => {
          for (const nestedFilter of filter.nestedFilter) {
            q.orWhere((qq: ModelQueryBuilderContract<T, InstanceType<T>>) => {
              this.resolveFilter<T>(nestedFilter, qq);
            });
          }
        });
        return query;
      }
    }

    return filter.operator.executor(query, filter.filterAttribute, filter.filterValue);
  }

}
