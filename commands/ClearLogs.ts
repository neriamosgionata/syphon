import {BaseCommand} from '@adonisjs/core/build/standalone'
import Console from "@ioc:Providers/Console";
import Drive from "@ioc:Adonis/Core/Drive";

export default class ClearLogs extends BaseCommand {
  public static commandName = 'clear:logs'

  public static description = ''

  public static settings = {
    loadApp: true,

    stayAlive: false,
  }

  public async run() {
    const allFiles = Drive.list("logs");

    const files: string[] = [];

    for (const file of await allFiles.toArray()) {
      if (file.location.includes(".log")) {
        files.push(file.location);
        await Drive.delete(file.location);
      }
    }

    Console.log('Cleared files:');
    Console.table(files);
    Console.log('Done');
  }
}
