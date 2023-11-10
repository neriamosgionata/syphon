import {HttpContextContract} from "@ioc:Adonis/Core/HttpContext";
import Filters from "@ioc:Providers/Filters";

export default class SearchQueryMiddleware {

  async handle({request, response}: HttpContextContract, next: () => void | Promise<void>, baseModel?: string) {
    await next();

    const {query, limit, page, sort, order} = request.qs();

    if (!baseModel) {
      return response.badRequest("No base model provided");
    }

    const loadedModel = require(`App/Models/${baseModel}`);
    let queryBuilder = loadedModel.default.query();

    if (query) {
      const filter = Filters.parseQueryString(query);
      queryBuilder = Filters.resolveFilter(filter, queryBuilder);
    }

    if (sort && order) {
      queryBuilder.orderBy(sort, order);
    }

    if (limit) {
      queryBuilder.limit(limit);
    }

    if (page) {
      queryBuilder.offset((page - 1) * limit);
    }

    const data = await queryBuilder.exec();

    const resp = {
      data: data,
      meta: {
        total: queryBuilder.count,
        page: page,
        limit: limit,
      },
    }

    return response.json(resp);
  }

}
