import Server from '@ioc:Adonis/Core/Server'

Server.middleware.register([
  () => import('App/Middleware/Cors'),
  () => import('@ioc:Adonis/Core/BodyParser'),
])

Server.middleware.registerNamed({})
