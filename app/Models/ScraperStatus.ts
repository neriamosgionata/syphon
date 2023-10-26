import {DateTime} from 'luxon'
import {BaseModel, column} from '@ioc:Adonis/Lucid/Orm'

export default class ScraperStatus<T extends { [p: string | number]: any }> extends BaseModel {
  @column({isPrimary: true})
  public id: number;

  @column()
  public name: string;

  @column()
  public status: T;

  @column.dateTime({autoCreate: true})
  public createdAt: DateTime

  @column.dateTime({autoCreate: true, autoUpdate: true})
  public updatedAt: DateTime
}
