import {args, BaseCommand} from "@adonisjs/core/build/standalone";
import Profiler from "@ioc:Providers/Profiler";

export default class TestProfiler extends BaseCommand {
  /**
   * Command name is used to run the command
   */
  public static commandName = "test:profiler";

  /**
   * Command description is displayed in the "help" output
   */
  public static description = "";

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
     * `node ace generate:manifest` afterward.
     */
    stayAlive: false
  };

  @args.string({description: "Query", required: true})
  public query: string;

  public async run() {
    console.log(await Profiler.askAnything(this.query));
  }
}
