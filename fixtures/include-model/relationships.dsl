    traveller -> portal "Prices a risk" "HTTPS" {
      properties {
        "d.interaction" "sync"
        "d.encrypted" "yes"
        "d.authenticated" "yes"
      }
    }
    portal -> api "Requests booking" "HTTPS/JSON" {
      properties {
        "d.interaction" "sync"
      }
    }
    api -> surcharge "Rates layer" "gRPC" {
      properties {
        "d.interaction" "sync"
        "d.retry" "fixed"
        "d.retry.max" "3"
        "d.idempotent" "yes"
      }
    }
    api -> bookings "Saves booking" "EF Core" {
      properties {
        "d.interaction" "sync"
        "d.writes" "Booking"
      }
    }
    api -> escalations "Sends escalation" "Azure Service Bus" {
      properties {
        "d.interaction" "async"
        "d.delivery" "at-least-once"
      }
    }
    surcharge -> catAdapter "Requests modelled loss" "gRPC" {
      properties {
        "d.interaction" "sync"
        "d.idempotent" "yes"
      }
    }
    catAdapter -> catVendor "Submits weather feed run" "HTTPS" {
      properties {
        "d.interaction" "sync"
        "d.encrypted" "yes"
        "d.retry" "backoff"
        "d.retry.max" "5"
        "d.idempotent" "no"
      }
    }
    escalations -> bookings "Updates booking status" "Dapper" {
      properties {
        "d.interaction" "sync"
        "d.writes" "Booking"
        "d.concurrency" "none"
      }
    }
