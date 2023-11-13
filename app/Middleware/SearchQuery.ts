import {HttpContextContract} from "@ioc:Adonis/Core/HttpContext";
import Filters from "@ioc:Providers/Filters";
import {ModelQueryBuilderContract} from "@ioc:Adonis/Lucid/Orm";

export default class SearchQueryMiddleware {

  async handle({request, response}: HttpContextContract, next: () => void | Promise<void>, baseModel?: string) {
    await next();

    let {query, perPage, page, sort, order} = request.qs();

    perPage = perPage ?? 25;
    page = page ?? 1;

    if (!baseModel) {
      return response.badRequest("No base model provided");
    }

    const loadedModel = require(`App/Models/${baseModel}`);

    let queryBuilder: ModelQueryBuilderContract<any, any> = loadedModel.default.query();

    if (query) {
      const filter = Filters.parseQueryString(query);
      queryBuilder = Filters.resolveFilter(filter, queryBuilder);
    }

    if (sort && order) {
      queryBuilder.orderBy(sort, order);
    }

    const data = await queryBuilder.paginate(page, perPage);

    const resp = {
      data: data.all(),
      meta: {
        total: data.total,
        page: page,
        perPage: perPage,
      },
    }

    return response.json(resp);
  }

}
