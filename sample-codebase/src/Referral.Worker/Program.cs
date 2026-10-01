using Azure.Messaging.ServiceBus;
using Microsoft.EntityFrameworkCore;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddDbContext<QuotesDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Quotes")));
// Re-rates referred quotes. Not in the design.
builder.Services.AddHttpClient<RatingClient>(c =>
    c.BaseAddress = new Uri(builder.Configuration["Services:RatingEngine"]!));
builder.Services.AddSingleton(new ServiceBusClient(builder.Configuration.GetConnectionString("ServiceBus")));
builder.Services.AddHostedService<ReferralHandler>();
builder.Build().Run();
