      escalations = container "Escalation Worker" "" ".NET 8" {
        properties {
          "d.instances" "2"
        }
      }
      bookings = container "Bookings DB" "" "Azure SQL" "Database"
