workspace "fullstack " {
  model {
    e_entraid = softwareSystem "Entra ID" {
      tags "External"
    }
    e_newrelic = softwareSystem "New Relic" {
      tags "External"
    }
    sys = softwareSystem "fullstack" {
      e_shopapi = container "Shop.Api" "" "ASP.NET Core" {
      }
      e_shopfunctions = container "Shop.Functions" "" "Azure Functions (.NET isolated)" {
      }
      e_snowflake = container "Snowflake" "" "Snowflake" "Database"
      e_nodeapi = container "node-api" "" "Node.js (Express)" {
      }
      e_ui = container "ui" "" "React SPA (Vite)" {
      }
    }

    e_shopapi -> e_snowflake "Reads and writes" "Snowflake" {
      properties {
        "d.interaction" "sync"
      }
    }
    e_shopfunctions -> e_snowflake "Reads and writes" "Snowflake" {
      properties {
        "d.interaction" "sync"
      }
    }
    e_shopapi -> e_entraid "Authenticates via" "Identity provider" {
      properties {
        "d.interaction" "sync"
      }
    }
    e_ui -> e_entraid "Authenticates via" "MSAL" {
      properties {
        "d.interaction" "sync"
      }
    }
    e_ui -> e_newrelic "Authenticates via" "New Relic agent" {
      properties {
        "d.interaction" "sync"
      }
    }
    e_ui -> e_shopapi "Calls 3 endpoint(s)" "HTTP" {
      properties {
        "d.interaction" "sync"
      }
    }
  }
}
