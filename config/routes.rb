# frozen_string_literal: true

CommunityCustomFields::Engine.routes.draw { put "/:topic_id" => "custom_fields#update" }

Discourse::Application.routes.draw do
  mount ::CommunityCustomFields::Engine, at: "/admin/plugins/community-custom-fields"
end
