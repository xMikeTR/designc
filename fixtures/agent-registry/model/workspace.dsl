workspace "Claims triage" {
  model {
    triage = softwareSystem "Claims triage" {
      agent = container "Triage agent" "Routes incoming claims" "MAF agent" {
        properties {
          "d.agent.autonomy" "approve-writes"
          "d.agent.eval" "EV-triage"
        }
      }
    }
  }
}
