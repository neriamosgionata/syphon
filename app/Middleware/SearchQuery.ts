import {HttpContextContract} from "@ioc:Adonis/Core/HttpContext";
import Filters from "@ioc:Providers/Filters";

export default (baseModel: string) => {
  return async ({request, response}: HttpContextContract, next: () => void | Promise<void>) => {
    await next();

    const {query, limit, page, sort, order} = request.qs();

    const loadedModel = await import(`App/Models/${baseModel}`);

    let queryBuilder = loadedModel.query();

    const filter = Filters.parseQueryString(query);

    queryBuilder = Filters.resolveFilter(filter, queryBuilder);

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
