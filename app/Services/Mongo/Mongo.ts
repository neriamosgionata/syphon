import {Db, MongoClient} from "mongodb";

export interface MongoContract {
  isReady(): boolean;

  client: MongoClient;
  db: Db;
}

export default class Mongo implements MongoContract {
  client!: MongoClient;
  db!: Db;

  constructor(public url: string, public dbName: string) {
    this.client = new MongoClient(this.url, {});

    this.client.connect().then(() => {
      this.db = this.client.db(this.dbName);
    });
  }

  isReady() {
    return this.db !== undefined;
  }
}
