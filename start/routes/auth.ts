import Route from "@ioc:Adonis/Core/Route";

Route.post("login", async ({ auth, request }) => {
  const email = request.input("email");
  const password = request.input("password");

  await auth.use("web").attempt(email, password);
});
