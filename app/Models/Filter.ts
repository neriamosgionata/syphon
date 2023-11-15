import {LucidModel, ModelQueryBuilderContract} from "@ioc:Adonis/Lucid/Orm";

export type Symbol = string;

export type OperatorFunction<T extends LucidModel> = (
  query: ModelQueryBuilderContract<T, InstanceType<T>>,
  attribute: string,
  attributeValue: any
) => ModelQueryBuilderContract<T, InstanceType<T>>;

export type Operator<T extends LucidModel> = {
  symbol: Symbol
  executor: OperatorFunction<T>
}

export interface Filter<T extends LucidModel> {
  filterAttribute: string
  filterValue: any
  operator: Operator<T>
  nested: boolean
  nestedFilter: Filter<T>[]
}

export const OpeningBracket = "(";
export const ClosingBracket = ")";

export const FilterSplitter: Symbol = ";";

export const BooleanAndSym: Symbol = "&";
export const BooleanOrSym: Symbol = "|";
export const LikeSym: Symbol = "like";
export const NotLikeSym: Symbol = "!like";
export const EqualSym: Symbol = "=";
export const NotEqualSym: Symbol = "!=";
export const GreaterThanSym: Symbol = ">";
export const GreaterThanOrEqualSym: Symbol = ">=";
export const LessThanSym: Symbol = "<";
export const LessThanOrEqualSym: Symbol = "<=";
export const IncludesSym: Symbol = "∈";
export const NotIncludesSym: Symbol = "∉";
export const NilSym: Symbol = "null";
export const NotNilSym: Symbol = "!null";

export const Operators: { [p: Symbol]: Operator<any> } = {
  [NilSym]: {
    symbol: NilSym,
    executor: (q, a, _av) => {
      return q.whereNull(a);
    },
  },
  [NotNilSym]: {
    symbol: NotNilSym,
    executor: (q, a, _av) => {
      return q.whereNotNull(a);
    },
  },
  [BooleanAndSym]: {
    symbol: BooleanAndSym,
    executor: (_q, _a, _av) => {
      throw new Error("Not callable");
    },
  },

  [BooleanOrSym]: {
    symbol: BooleanOrSym,
    executor: (_q, _a, _av) => {
      throw new Error("Not callable");
    },
  },

  [EqualSym]: {
    symbol: EqualSym,
    executor: (q, a, av) => {
      return q.where(a, "=", av);
    },
  },

  [NotEqualSym]: {
    symbol: NotEqualSym,
    executor: (q, a, av) => {
      return q.whereNot(a, av);
    },
  },

  [GreaterThanSym]: {
    symbol: GreaterThanSym,
    executor: (q, a, av) => {
      return q.where(a, ">", av);
    },
  },

  [GreaterThanOrEqualSym]: {
    symbol: GreaterThanOrEqualSym,
    executor: (q, a, av) => {
      return q.where(a, ">=", av);
    },
  },

  [LessThanSym]: {
    symbol: LessThanSym,
    executor: (q, a, av) => {
      return q.where(a, "<", av);
    },
  },

  [LessThanOrEqualSym]: {
    symbol: LessThanOrEqualSym,
    executor: (q, a, av) => {
      return q.where(a, "<=", av);
    },
  },

  [IncludesSym]: {
    symbol: IncludesSym,
    executor: (q, a, av) => {
      return q.whereIn(a, av);
    },
  },

  [NotIncludesSym]: {
    symbol: NotIncludesSym,
    executor: (q, a, av) => {
      return q.whereNotIn(a, av);
    },
  },

  [LikeSym]: {
    symbol: LikeSym,
    executor: (q, a, av) => {
      return q.where(a, "like", av);
    },
  },

  [NotLikeSym]: {
    symbol: NotLikeSym,
    executor: (q, a, av) => {
      return q.where(a, "not like", av);
    },
  },
};
