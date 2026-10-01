using Shop.Api.Endpoints;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddAuthentication().AddJwtBearer();

var app = builder.Build();

app.MapControllers();

var api = app.MapGroup("/api/v1");
api.MapOrderEndpoints();

app.Run();
