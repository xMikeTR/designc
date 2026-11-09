workspace "Agreement booking" {
  model {
    traveller = person "Traveller"
    bookings = softwareSystem "Agreement Bookings" {
      app = container "Booking App" "Prices a agreement booking in the browser" "React" {
        fares = component "Fares" "Rebated and renewal fee" "TypeScript" {
          properties {
            "d.code" "src/fares/**"
            "d.risk" "high"
          }
        }
        validation = component "Validation" "Limit and field rules" "TypeScript" {
          properties {
            "d.code" "src/validation/**"
            "d.risk" "medium"
          }
        }
        summary = component "Summary" "The line under Calculate" "TypeScript" {
          properties {
            "d.code" "src/summary/**"
            "d.risk" "low"
          }
        }
      }
    }
    traveller -> app "Requests a booking" "HTTPS" {
      properties {
        "d.interaction" "sync"
      }
    }
  }
}
