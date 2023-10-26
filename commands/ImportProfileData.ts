import {args, BaseCommand} from '@adonisjs/core/build/standalone'
import {JobContract} from "App/Services/Jobs/Jobs";
import {AppContainerAliasesEnum} from "App/Enums/AppContainerAliasesEnum";
import {ImportProfileDataJobParameters} from "App/Jobs/ImportProfileDataJob";

export default class ImportProfileData extends BaseCommand {
  /**
   * Command name is used to run the command
   */
  public static commandName = 'import:profile_data'

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

  @args.string({description: "Ticker", required: true})
  public ticker: string;

  public async run() {
    const Jobs: JobContract = this.application.container.use(AppContainerAliasesEnum.Jobs);

    await Jobs.waitUntilDone(
      await Jobs.dispatch<ImportProfileDataJobParameters>(
        "ImportProfileDataJob",
        {
          ticker: this.ticker.split(","),
        }
      )
    );
  }
}
