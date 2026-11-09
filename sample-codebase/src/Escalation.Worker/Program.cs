using Azure.Messaging.ServiceBus;
using Microsoft.EntityFrameworkCore;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddDbContext<BookingsDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Bookings")));
// Re-rates referred bookings. Not in the design.
builder.Services.AddHttpClient<SurchargeClient>(c =>
    c.BaseAddress = new Uri(builder.Configuration["Services:SurchargeEngine"]!));
builder.Services.AddSingleton(new ServiceBusClient(builder.Configuration.GetConnectionString("ServiceBus")));
builder.Services.AddHostedService<EscalationHandler>();
builder.Build().Run();
