declare module "@ioc:Providers/Newsletter" {
  import {NewsletterContract} from "App/Services/Newsletter/Newsletter";
  const Newsletter: NewsletterContract;
  export default Newsletter;
}
