import Route from "@ioc:Adonis/Core/Route";


Route.group(() => {
  Route
    .resource("charts", "ChartsController")
    .apiOnly()
    .middleware({index: ["search:TickerChart"]});
})
  .middleware(["auth:api"])
  .prefix("api/v1")
