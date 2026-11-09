workspace "Shop (split repos)" {
  model {
    shop = softwareSystem "Shop" {
      api = container "Shop.Api" "" "ASP.NET Core" {
        properties { "d.repo" "Api" "d.code" "src/Shop.Api/**" "d.risk" "low" }
      }
      ui = container "ui" "" "React" {
        properties { "d.repo" "Ui" "d.code" "src/**" "d.risk" "low" }
      }
      ui -> api "Calls"
    }
  }
  views {
    container shop "Containers" { include * autoLayout }
  }
}
