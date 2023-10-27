import {args, BaseCommand} from "@adonisjs/core/build/standalone";
import Newsletter from "@ioc:Providers/Newsletter";
import Logger from "@ioc:Providers/Logger";

export default class TestNewsletterArticles extends BaseCommand {
  /**
   * Command name is used to run the command
   */
  public static commandName = "test:newsletter_articles";

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
    const res = await Newsletter.getGoogleNewsArticlesFor(this.query);

    if (res.errors.length) {
      Logger.error(res.errors.map(e => e.message).join("\n"));
      return;
    }

    const articles = await Newsletter.getArticles(res.results.articlesUrl);

    for (let entry of articles.entries()) {
      if (entry[1].errors.length) {
        Logger.error(entry[1].errors.map(e => e.message).join("\n"));
        continue;
      }
      Logger.info(entry[1].results.title);
    }
  }
}
