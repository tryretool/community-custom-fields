# frozen_string_literal: true

class CommunityCustomFields::CustomFieldsController < ::ApplicationController
  requires_plugin CommunityCustomFields::PLUGIN_NAME

  before_action :ensure_logged_in
  before_action :ensure_admin

  def update
    topic = Topic.find(params[:topic_id])
    custom = params[:custom_field] || params.permit(:assignee_id, :status)
    topic.custom_fields["assignee_id"] = custom[:assignee_id].to_i if custom[:assignee_id].present?
    topic.custom_fields["status"] = custom[:status] if custom[:status].present?
    if topic.save_custom_fields
      render json: success_json
    else
      Rails.logger.error("Failed to save custom fields for topic #{topic.id}: #{topic.errors.full_messages}")
      render json: { error: topic.errors.full_messages }, status: 422
    end
  end
end