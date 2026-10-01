using Microsoft.AspNetCore.Mvc;

namespace Shop.Api.Controllers;

[ApiController]
[Route("api/v1/[controller]")]
public class CustomersController : ControllerBase
{
    [HttpGet("{id}")]
    public IActionResult GetCustomer(string id)
    {
        return Ok(new { id });
    }
}
