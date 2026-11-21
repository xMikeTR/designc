    fares = softwareSystem "Fares Platform" {
      properties {
        "d.zone" "platform"
      }
      portal = container "Fares Portal" "" "React" {
        properties {
          "d.instances" "2"
          "d.availability" "0.999"
        }
      }
      api = container "Fares API" "" ".NET 8" {
        properties {
          "d.instances" "3"
          "d.critical" "yes"
          "d.availability" "0.999"
        }
      }
      surcharge = container "Surcharge Engine" "" "F#" {
        properties {
          "d.instances" "1"
          "d.critical" "yes"
          "d.availability" "0.999"
        }
      }
      catAdapter = container "Weather Feed Adapter" "" "Python" {
        properties {
          "d.instances" "1"
          "d.critical" "yes"
          "d.availability" "0.999"
          "d.suppress" "DC005: vendor licence is per-instance; falls back to cached losses (ADR-014)"
        }
      }
      !include fares/workers.dsl
    }
