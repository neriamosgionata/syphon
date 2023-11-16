import {BaseCommand} from '@adonisjs/core/build/standalone'
import fs from "fs";
import Console from "@ioc:Providers/Console";

export default class ClearLogs extends BaseCommand {
  /**
   * Command name is used to run the command
   */
  public static commandName = 'clear:logs'

  /**
   * Command description is displayed in the "help" output
   */
  public static description = ''

  public static settings = {
    /**
     * Set the following value to true, if you want to load the application
     * before running the command. Don't forget to call `node ace generate:manifest`
     * afterwards.
     */
    loadApp: true,

    /**
     * Set the following value to true, if you want this command to keep running until
     * you manually decide to exit the process. Don't forget to call
     * `node ace generate:manifest` afterwards.
     */
    stayAlive: false,
  }

  public async run() {
    const allFiles = fs.readdirSync('storage/logs');

    const files: string[] = [];

    allFiles.forEach((file) => {
      if (file.includes('.log')) {
        fs.rmSync('storage/logs/' + file);
        files.push('storage/logs/' + file);
      }
    });

    Console.log('Cleared files:');
    Console.table(files);
    Console.log('Done');
  }
}
