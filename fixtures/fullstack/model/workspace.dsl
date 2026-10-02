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
        c_shopapi_appshell = component "App shell" "" ""
        c_shopapi_customerscontroller = component "CustomersController" "" ""
        c_shopapi_orderendpoints = component "OrderEndpoints" "" ""
        c_shopapi_shopinfrastructure = component "Shop.Infrastructure" "" ""
      }
      e_shopfunctions = container "Shop.Functions" "" "Azure Functions (.NET isolated)" {
        c_shopfunctions_appshell = component "App shell" "" ""
        c_shopfunctions_orderfunctions = component "OrderFunctions" "" ""
        c_shopfunctions_shopinfrastructure = component "Shop.Infrastructure" "" ""
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
