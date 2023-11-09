import Route from "@ioc:Adonis/Core/Route";
import SearchQuery from "App/Middleware/SearchQuery";

Route
  .resource("charts", "ChartsController")
  .apiOnly()
  .middleware({
    "*": [
      "auth"
    ],
    index: [
      "auth",
      SearchQuery("TickerChart")
    ]
  });
