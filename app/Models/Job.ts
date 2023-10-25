import {DateTime} from "luxon";
import {BaseModel, column} from "@ioc:Adonis/Lucid/Orm";
import {JobStatusEnum} from "App/Enums/JobStatusEnum";

export default class Job extends BaseModel {
  @column({isPrimary: true})
  public id: string;

  @column()
  public name: string;

  @column()
  public tags: string | null;

  @column()
  public status: JobStatusEnum;

  @column()
  public parameters: string | null;

  @column()
  public error: string | null;

  @column()
  public errorStack: string | null;

  @column.dateTime()
  public startedAt: DateTime | null;

  @column.dateTime()
  public finishedAt: DateTime | null;

  @column.dateTime({autoCreate: true})
  public createdAt: DateTime;

  @column.dateTime({autoCreate: true, autoUpdate: true})
  public updatedAt: DateTime;
}
