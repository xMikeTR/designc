workspace "Bookings" {
  model {
    reseller = person "Reseller"
    bookings = softwareSystem "Bookings" {
      api = container "Bookings API" "Prices a booking" "ASP.NET Core" {
        properties {
          "d.owns" "Booking"
        }
      }
    }
    reseller -> api "Requests a booking" "HTTPS" {
      properties {
        "d.interaction" "sync"
      }
    }
  }
}
