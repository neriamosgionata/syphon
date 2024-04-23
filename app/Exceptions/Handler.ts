/*
|--------------------------------------------------------------------------
| Http Exception Handler
|--------------------------------------------------------------------------
|
| AdonisJs will forward all exceptions occurred during an HTTP request to
| the following class. You can learn more about exception handling by
| reading docs.
|
| The exception handler extends a base `HttpExceptionHandler` which is not
| mandatory, however it can do lot of heavy lifting to handle the errors
| properly.
|
*/

import Logger from '@ioc:Adonis/Core/Logger'
import HttpExceptionHandler from '@ioc:Adonis/Core/HttpExceptionHandler'
import {HttpContextContract} from "@ioc:Adonis/Core/HttpContext";
import Log from "@ioc:Providers/Logger";

export default class ExceptionHandler extends HttpExceptionHandler {
  constructor() {
    super(Logger)
  }

  report(error: any, ctx: HttpContextContract) {
    Log.error(error.message, error.stack)
      .then(() => {})
      .catch(() => {});
    super.report(error, ctx);
  }

  async handle(error: any, ctx: HttpContextContract) {
    await Log.error(error.message, error.stack);
    await super.handle(error, ctx);
  }
}
