# frozen_string_literal: true

CommunityCustomFields::Engine.routes.draw do
  put '/:topic_id' => 'custom_fields#update', as: 'custom_field'
end

Discourse::Application.routes.append do
  mount ::CommunityCustomFields::Engine, at: '/admin/plugins/community-custom-fields'
end