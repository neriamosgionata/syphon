import Route from "@ioc:Adonis/Core/Route";
import User from "App/Models/User";

Route.group(() => {

  Route.post("login", async ({auth, request, response}) => {
    const email = request.input("email");
    const password = request.input("password");

    const token = await auth.use("api").attempt(email, password);

    const user = token.user;

    response.json({token, user});
  });

  Route.post("logout", async ({auth}) => {
    await auth.use("api").logout();
  });

  Route.post("register", async ({auth, request, response}) => {
    const email = request.input("email");
    const password = request.input("password");
    const password_confirmation = request.input("password_confirmation");

    if (password !== password_confirmation) {
      return response.badRequest("Passwords do not match");
    }

    await User.create({
      email,
      password,
    });

    const token = await auth.use("api").attempt(email, password);

    const user = token.user;

    response.json({token, user});
  });

})
  .prefix("api/v1");
