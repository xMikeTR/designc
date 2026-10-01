// As-built model, extracted by designc from fullstack on 2026-10-01.
// Generated file: edit the design, not this.
workspace "fullstack (as built)" {
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
        c_nodeapi_appshell = component "App shell" "" ""
        c_nodeapi_routes = component "routes" "" ""
      }
      e_ui = container "ui" "" "React SPA (Vite)" {
        c_ui_api = component "api" "" ""
        c_ui_appshell = component "App shell" "" ""
        c_ui_auth = component "auth" "" ""
        c_ui_realtime = component "realtime" "" ""
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
    e_ui -> e_newrelic "Sends telemetry to" "New Relic agent" {
      properties {
        "d.interaction" "sync"
      }
    }
    e_ui -> e_shopapi "Calls 3 endpoint(s)" "HTTP" {
      properties {
        "d.interaction" "sync"
      }
    }
    c_shopapi_shopinfrastructure -> e_snowflake "Reads and writes" "Snowflake" { properties { "d.interaction" "sync" } }
    c_shopfunctions_shopinfrastructure -> e_snowflake "Reads and writes" "Snowflake" { properties { "d.interaction" "sync" } }
    c_shopapi_appshell -> e_entraid "Authenticates via" "Identity provider" { properties { "d.interaction" "sync" } }
    c_ui_auth -> e_entraid "Authenticates via" "MSAL" { properties { "d.interaction" "sync" } }
    c_ui_appshell -> e_newrelic "Sends telemetry to" "New Relic agent" { properties { "d.interaction" "sync" } }
    c_ui_api -> c_shopapi_customerscontroller "Calls 1 endpoint(s)" "HTTP" { properties { "d.interaction" "sync" } }
    c_ui_api -> c_shopapi_orderendpoints "Calls 2 endpoint(s)" "HTTP" { properties { "d.interaction" "sync" } }
  }
}
