import {DateTime} from "luxon";
import {BaseModel, column} from "@ioc:Adonis/Lucid/Orm";
import {JobMessageEnum} from "App/Enums/JobMessageEnum";
import {JobName} from "App/Services/Jobs/JobsTypes";

export default class Job extends BaseModel {
  @column({isPrimary: true})
  public id: string;

  @column()
  public name: JobName;

  @column()
  public tags: string | null;

  @column()
  public status: JobMessageEnum;

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
