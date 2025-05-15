# frozen_string_literal: true

class CommunityCustomFields::CustomFieldsController < ::ApplicationController
  requires_plugin CommunityCustomFields::PLUGIN_NAME

  before_action :ensure_logged_in
  before_action :ensure_admin

  def update
    topic = Topic.find(params[:topic_id])
    topic.custom_fields.merge!(custom_fields_params)
    if topic.save_custom_fields
      topic.touch
      render json: success_json
    else
      Rails.logger.error("Failed to save custom fields for topic #{topic.id}: #{topic.errors.full_messages}")
      render json: { error: topic.errors.full_messages }, status: 422
    end
  end

  private

  def custom_fields_params
    params.require(:custom_field).permit(*CommunityCustomFields::CUSTOM_FIELDS.keys)
  end
end