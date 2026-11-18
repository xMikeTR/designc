workspace "Bookings" {
  model {
    reseller = person "Reseller"
    bookings = softwareSystem "Bookings" {
      api = container "Bookings API" "Prices a booking" "ASP.NET Core"
    }
    reseller -> api "Requests a booking" "HTTPS" {
      properties {
        "d.interaction" "sync"
      }
    }
  }
}
