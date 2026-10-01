using System.Net;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace Shop.Functions;

public class OrderFunctions
{
    [Function("GetOrder")]
    public HttpResponseData GetOrder(
        [HttpTrigger(AuthorizationLevel.Function, "get", Route = "api/v1/orders/{id}")] HttpRequestData req,
        string id)
    {
        var response = req.CreateResponse(HttpStatusCode.OK);
        return response;
    }

    [Function("RelayOrderEvents")]
    [ServiceBusOutput("%OrdersTopic%", Connection = "ServiceBusConnection")]
    public static string RelayOrderEvents(
        [ServiceBusTrigger("orders", "audit", Connection = "ServiceBusConnection")] string message)
    {
        return message;
    }
}
