import Env from '@ioc:Adonis/Core/Env'
const appConfig = {
  appKey: Env.get('APP_KEY'),
  http: {
    allowMethodSpoofing: false,
    subdomainOffset: 2,
    generateRequestId: false,
    trustProxy: (address: string) => true,
    etag: false,
    jsonpCallbackName: 'callback',
    cookie: {
      domain: '',
      path: '/',
      maxAge: '2h',
      httpOnly: true,
      secure: false,
      sameSite: false as const,
    },
    forceContentNegotiationTo: 'application/json',
  },
  logger: {
    name: Env.get('APP_NAME'),
    enabled: true,
    level: Env.get('NODE_ENV') === 'development' ? 'debug' : 'info',
    prettyPrint: Env.get('NODE_ENV') === 'development',
  },
  profiler: { enabled: false },
  validator: { bail: true, reporter: async () => (await import('@ioc:Adonis/Core/Validator')).validator.reporters.api },
}

export default appConfig
